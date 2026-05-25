import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { db } from './db.js';

type MessageRow = {
  id: string;
  group_id: string;
  sent_at: string;
  type: string;
  content: string;
  raw_json: string | null;
};

type EmojiMetadata = {
  localId: number;
  md5: string;
  length: number;
  cdnUrl: string;
  encryptUrl: string;
  aesKey: string;
};

export type MessageEmoji = {
  path: string;
  mime: string;
  fileName: string;
  localId: number;
  md5: string;
};

const emojiCacheDir = path.resolve(process.cwd(), 'data', 'emoji-cache');
const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export async function resolveMessageEmoji(messageId: string): Promise<MessageEmoji | null> {
  const message = db.prepare(`
    SELECT id, group_id, sent_at, type, content, raw_json
    FROM messages
    WHERE id = ?
  `).get(messageId) as MessageRow | undefined;

  if (!message || !isEmojiMessage(message)) return null;

  const raw = parseRawJson(message.raw_json);
  const localId = readLocalId(raw, message.content, message.id);
  if (!localId) return null;

  const metadata = findEmojiMetadata(message.group_id, localId);
  if (!metadata?.md5) return null;

  const local = findRenderableLocalEmoji(message.sent_at, metadata.md5);
  if (local) {
    return {
      ...local,
      fileName: `${metadata.md5}${extensionForMime(local.mime)}`,
      localId,
      md5: metadata.md5
    };
  }

  const downloaded = await fetchAndCacheEmoji(metadata);
  if (!downloaded) return null;

  return {
    ...downloaded,
    localId,
    md5: metadata.md5
  };
}

function findEmojiMetadata(groupId: string, localId: number): EmojiMetadata | null {
  for (const dbPath of listWxCacheDatabases()) {
    let sqlite: Database.Database | null = null;
    try {
      sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
      const tables = sqlite.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'Msg_%'
      `).all() as Array<{ name: string }>;

      for (const table of tables) {
        try {
          const row = sqlite.prepare(`
            SELECT local_id, local_type, message_content
            FROM ${quoteIdentifier(table.name)}
            WHERE local_id = ?
              AND ((local_type & 4294967295) = 47 OR local_type = 47)
            LIMIT 1
          `).get(localId) as { message_content?: Buffer | string | null } | undefined;

          const xml = decodeMessageContent(row?.message_content);
          if (!xml || !xml.includes('<emoji')) continue;

          const attrs = extractTagAttributes(xml, 'emoji');
          if (groupId && attrs.tousername && attrs.tousername !== groupId) continue;
          const md5 = normalizeMd5(String(attrs.md5 || attrs.androidmd5 || ''));
          if (!md5) continue;

          return {
            localId,
            md5,
            length: Number(attrs.len || attrs.androidlen || 0) || 0,
            cdnUrl: String(attrs.cdnurl || ''),
            encryptUrl: String(attrs.encrypturl || ''),
            aesKey: String(attrs.aeskey || '')
          };
        } catch {
          // Some historical Msg_* tables have slightly different columns.
        }
      }
    } catch {
      // Ignore unrelated cache files; wx-cli keeps several SQLite databases here.
    } finally {
      sqlite?.close();
    }
  }
  return null;
}

function decodeMessageContent(value: Buffer | string | null | undefined) {
  if (!value) return '';
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  let decoded = buffer;
  if (buffer.subarray(0, 4).equals(zstdMagic)) {
    try {
      decoded = zstdDecompressSync(buffer);
    } catch {
      return '';
    }
  }
  const text = decoded.toString('utf8');
  const start = text.indexOf('<msg');
  return start >= 0 ? text.slice(start) : text;
}

function findRenderableLocalEmoji(sentAt: string, md5: string): { path: string; mime: string } | null {
  const root = getWeChatFilesRoot();
  if (!root) return null;

  const candidates = new Set<string>();
  for (const month of nearbyMonths(sentAt)) {
    candidates.add(path.join(root, 'cache', month, 'Emoticon', md5.slice(0, 2), md5));
  }

  for (const filePath of candidates) {
    if (!isSafeChild(path.join(root, 'cache'), filePath)) continue;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const mime = detectMime(filePath);
    if (mime !== 'application/octet-stream') return { path: filePath, mime };
  }
  return null;
}

async function fetchAndCacheEmoji(metadata: EmojiMetadata): Promise<{ path: string; mime: string; fileName: string } | null> {
  const url = normalizeWechatUrl(metadata.cdnUrl);
  if (!url) return null;

  fs.mkdirSync(emojiCacheDir, { recursive: true });
  const existing = findCachedEmoji(metadata.md5);
  if (existing) return existing;

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) return null;

  const downloadedMd5 = crypto.createHash('md5').update(buffer).digest('hex');
  if (metadata.md5 && downloadedMd5 !== metadata.md5) return null;

  const mime = detectMimeFromBuffer(buffer);
  if (mime === 'application/octet-stream') return null;

  const fileName = `${metadata.md5}${extensionForMime(mime)}`;
  const filePath = path.join(emojiCacheDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, mime, fileName };
}

function findCachedEmoji(md5: string) {
  for (const ext of ['.webp', '.gif', '.png', '.jpg', '.jpeg']) {
    const filePath = path.join(emojiCacheDir, `${md5}${ext}`);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const mime = detectMime(filePath);
    if (mime !== 'application/octet-stream') return { path: filePath, mime, fileName: path.basename(filePath) };
  }
  return null;
}

function listWxCacheDatabases() {
  const cacheDir = path.join(os.homedir(), '.wx-cli', 'cache');
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => path.join(cacheDir, name));
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

function nearbyMonths(value: string) {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return [-1, 0, 1].map((offset) => {
    const next = new Date(date);
    next.setUTCMonth(next.getUTCMonth() + offset);
    return next.toISOString().slice(0, 7);
  });
}

function parseRawJson(rawJson: string | null) {
  try {
    return rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readLocalId(raw: Record<string, unknown>, content: string, id: string) {
  const direct = raw.local_id ?? raw.localId ?? raw.id;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
  const match = content.match(/local_id=(\d+)/i);
  if (match) return Number(match[1]);
  return /^\d+$/.test(id) ? Number(id) : 0;
}

function isEmojiMessage(message: MessageRow) {
  return /表情|emoji|emoticon/i.test(message.type) || /\[表情\]/.test(message.content);
}

function extractTagAttributes(xml: string, tag: string) {
  const tagStart = xml.search(new RegExp(`<${tag}\\b`, 'i'));
  if (tagStart < 0) return {};
  const tagEnd = xml.indexOf('>', tagStart);
  const source = xml.slice(tagStart, tagEnd > tagStart ? tagEnd : tagStart + 5000);
  const attrs: Record<string, string> = {};
  source.replace(/([:\w-]+)\s*=\s*"([^"]*)"/g, (_full, key: string, value: string) => {
    attrs[key] = decodeXmlEntities(value);
    return '';
  });
  return attrs;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeMd5(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : '';
}

function normalizeWechatUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function isSafeChild(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function detectMime(filePath: string) {
  return detectMimeFromBuffer(fs.readFileSync(filePath));
}

function detectMimeFromBuffer(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function extensionForMime(mime: string) {
  const map: Record<string, string> = {
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  };
  return map[mime] || '.bin';
}
