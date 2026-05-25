import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import { runWx } from './wx.js';

type MessageRow = {
  id: string;
  group_id: string;
  sent_at: string;
  type: string;
  content: string;
  raw_json: string | null;
};

const mediaCacheDir = path.resolve(process.cwd(), 'data', 'media-cache');

export type MessageImage = {
  path: string;
  mime: string;
  localId: number;
};

export type MessageFile = {
  path: string;
  fileName: string;
  mime: string;
};

export async function resolveMessageImage(messageId: string): Promise<MessageImage | null> {
  return resolveMessageMedia(messageId, 'image');
}

export async function resolveMessageVideo(messageId: string): Promise<MessageImage | null> {
  return resolveMessageVideoAsset(messageId, 'full');
}

export async function resolveMessageVideoThumbnail(messageId: string): Promise<MessageImage | null> {
  return resolveMessageVideoAsset(messageId, 'thumb');
}

export async function resolveMessageFile(messageId: string): Promise<MessageFile | null> {
  const message = db.prepare(`
    SELECT id, group_id, sent_at, type, content, raw_json
    FROM messages
    WHERE id = ?
  `).get(messageId) as MessageRow | undefined;
  if (!message || !/\[文件\]|文件/i.test(message.content) && !/文件/i.test(message.type)) return null;

  const parsed = parseFileInfo(message.content);
  if (!parsed.fileName) return null;

  const root = getWeChatFilesRoot();
  if (!root) return null;
  const month = monthFromTime(message.sent_at);
  const filePath = path.join(root, 'msg', 'file', month, parsed.fileName);
  const normalizedRoot = path.join(root, 'msg', 'file', month);
  if (!filePath.startsWith(normalizedRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;

  return {
    path: filePath,
    fileName: parsed.fileName,
    mime: mimeFromExtension(path.extname(parsed.fileName).slice(1))
  };
}

async function resolveMessageMedia(messageId: string, kind: 'image' | 'video'): Promise<MessageImage | null> {
  const message = db.prepare(`
    SELECT id, group_id, sent_at, type, content, raw_json
    FROM messages
    WHERE id = ?
  `).get(messageId) as MessageRow | undefined;
  if (!message || !matchesKind(message, kind)) return null;

  const raw = parseRawJson(message.raw_json);
  const localId = readLocalId(raw, message.content);
  if (!localId) return null;

  const timestamp = readTimestamp(raw, message.sent_at);
  if (!timestamp) return null;

  fs.mkdirSync(mediaCacheDir, { recursive: true });
  const attachmentId = await resolveAttachmentId(message.group_id, localId, timestamp, kind);
  if (!attachmentId) return null;

  const filePath = path.join(mediaCacheDir, `${hash(attachmentId)}.image`);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    if (!await extractAttachment(attachmentId, filePath)) return null;
  }

  return {
    path: filePath,
    mime: detectMime(filePath, kind),
    localId
  };
}

async function resolveMessageVideoAsset(messageId: string, variant: 'full' | 'thumb'): Promise<MessageImage | null> {
  const message = db.prepare(`
    SELECT id, group_id, sent_at, type, content, raw_json
    FROM messages
    WHERE id = ?
  `).get(messageId) as MessageRow | undefined;
  if (!message || !matchesKind(message, 'video')) return null;

  const raw = parseRawJson(message.raw_json);
  const localId = readLocalId(raw, message.content);
  if (!localId) return null;
  const timestamp = readTimestamp(raw, message.sent_at);
  if (!timestamp) return null;

  const root = getWeChatFilesRoot();
  if (!root) return null;
  const digest = findVideoDigest(message.group_id, localId, timestamp);
  if (!digest) return null;

  const month = monthFromTimestamp(timestamp);
  const videoDir = path.join(root, 'msg', 'video', month);
  const filePath = variant === 'full'
    ? firstExistingFile(videoDir, [`${digest}.mp4`, `${digest}_raw.mp4`])
    : firstExistingFile(videoDir, [`${digest}_thumb.jpg`, `${digest}.jpg`, `${digest}_thumb.png`, `${digest}.png`]);
  if (!filePath || !isPathInside(videoDir, filePath)) return null;

  return {
    path: filePath,
    mime: detectMime(filePath, variant === 'full' ? 'video' : 'image'),
    localId
  };
}

function findVideoDigest(chatId: string, localId: number, timestamp: number) {
  const cacheDb = openMessageResourceCache();
  if (!cacheDb) return '';
  try {
    const row = cacheDb.prepare(`
      SELECT i.packed_info AS packedInfo
      FROM MessageResourceInfo i
      JOIN ChatName2Id c ON c.rowid = i.chat_id
      WHERE c.user_name = ?
        AND i.message_local_id = ?
        AND i.message_create_time = ?
        AND i.message_local_type = 43
      LIMIT 1
    `).get(chatId, localId, timestamp) as { packedInfo?: Buffer | string } | undefined;
    return extractDigest(row?.packedInfo);
  } catch {
    return '';
  } finally {
    cacheDb.close();
  }
}

function openMessageResourceCache(): BetterSqlite3.Database | null {
  const cacheDir = path.join(os.homedir(), '.wx-cli', 'cache');
  if (!fs.existsSync(cacheDir)) return null;
  for (const fileName of fs.readdirSync(cacheDir)) {
    if (!fileName.endsWith('.db')) continue;
    const filePath = path.join(cacheDir, fileName);
    let cacheDb: BetterSqlite3.Database | null = null;
    try {
      cacheDb = new Database(filePath, { readonly: true, fileMustExist: true });
      const tables = cacheDb.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('MessageResourceInfo', 'MessageResourceDetail', 'ChatName2Id')
      `).all() as Array<{ name: string }>;
      if (tables.length === 3) return cacheDb;
      cacheDb.close();
    } catch {
      cacheDb?.close();
      // Try the next wx-cli cache database.
    }
  }
  return null;
}

function extractDigest(value: Buffer | string | undefined) {
  if (!value) return '';
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  return text.match(/[a-f0-9]{32}/i)?.[0].toLowerCase() || '';
}

function firstExistingFile(baseDir: string, names: string[]) {
  for (const name of names) {
    const filePath = path.join(baseDir, name);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0) return filePath;
  }
  return '';
}

function isPathInside(baseDir: string, filePath: string) {
  const relative = path.relative(baseDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveAttachmentId(groupId: string, localId: number, timestamp: number, kind: 'image' | 'video') {
  const generated = buildAttachmentId(groupId, localId, timestamp, kind);
  const quickPath = path.join(mediaCacheDir, `${hash(generated)}.image`);
  if (fs.existsSync(quickPath) && fs.statSync(quickPath).size > 0) return generated;
  if (await extractAttachment(generated, quickPath)) return generated;

  if (kind !== 'image') return '';
  const official = await findAttachmentId(groupId, localId, timestamp);
  return official || '';
}

async function extractAttachment(attachmentId: string, outputPath: string) {
  const result = await runWx(['extract', attachmentId, '--output', outputPath, '--overwrite', '--json'], 60_000);
  if (result.exitCode === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return true;
  try {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  } catch {
    // best-effort cleanup only
  }
  return false;
}

async function findAttachmentId(groupId: string, localId: number, timestamp: number) {
  const day = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const result = await runWx(['attachments', groupId, '--kind', 'image', '--since', day, '--until', day, '-n', '1000', '--json'], 60_000);
  if (result.exitCode !== 0) return '';
  try {
    const parsed = JSON.parse(result.stdout || '{}') as { attachments?: Array<Record<string, unknown>> };
    const match = (parsed.attachments || []).find((item) => Number(item.local_id) === localId);
    return typeof match?.attachment_id === 'string' ? match.attachment_id : '';
  } catch {
    return '';
  }
}

function parseRawJson(rawJson: string | null) {
  try {
    return rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseFileInfo(content: string) {
  const marker = '[文件]';
  const index = content.lastIndexOf(marker);
  if (index < 0) return { fileName: '' };
  let line = content.slice(index + marker.length).split('\n')[0].trim();
  const metaStart = line.lastIndexOf(' (');
  if (metaStart > 0 && line.endsWith(')')) {
    const meta = line.slice(metaStart + 2, -1);
    if (meta.includes(',')) line = line.slice(0, metaStart).trim();
  }
  return { fileName: path.basename(line) };
}

function getWeChatFilesRoot() {
  try {
    const configPath = path.join(os.homedir(), '.wx-cli', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { db_dir?: string };
    return config.db_dir ? path.dirname(config.db_dir) : '';
  } catch {
    return '';
  }
}

function monthFromTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7);
  return date.toISOString().slice(0, 7);
}

function monthFromTimestamp(timestamp: number) {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return monthFromTime('');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function readLocalId(raw: Record<string, unknown>, content: string) {
  const direct = raw.local_id ?? raw.localId ?? raw.id;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
  const match = content.match(/local_id=(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function readTimestamp(raw: Record<string, unknown>, sentAt: string) {
  const direct = raw.timestamp ?? raw.create_time ?? raw.createTime;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct > 10_000_000_000 ? Math.floor(direct / 1000) : direct;
  if (typeof direct === 'string' && /^\d+$/.test(direct)) {
    const value = Number(direct);
    return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  }
  const parsed = new Date(sentAt).getTime();
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function buildAttachmentId(chat: string, localId: number, createTime: number, kind: 'image' | 'video') {
  return Buffer.from(JSON.stringify({
    v: 1,
    chat,
    local_id: localId,
    create_time: createTime,
    kind
  })).toString('base64url');
}

function hash(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function matchesKind(message: MessageRow, kind: 'image' | 'video') {
  if (kind === 'image') return /图片|image/i.test(message.type) || /\[图片\]/.test(message.content);
  return /视频|video/i.test(message.type) || /\[视频\]/.test(message.content);
}

function detectMime(filePath: string, kind: 'image' | 'video') {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (kind === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

function mimeFromExtension(ext: string) {
  const normalized = ext.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    rar: 'application/vnd.rar',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    json: 'application/json',
    bin: 'application/octet-stream'
  };
  return map[normalized] || 'application/octet-stream';
}
