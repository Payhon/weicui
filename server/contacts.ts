import { db } from './db.js';
import { wxJson } from './wx.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

type AnyRecord = Record<string, unknown>;

type ContactInput = {
  username?: string;
  remarkName?: string;
  nickname?: string;
  displayName?: string;
  avatarUrl?: string;
  source?: string;
  rawJson?: string;
};

type ContactRow = {
  username: string;
  remark_name: string | null;
  nickname: string | null;
  display_name: string;
  avatar_url: string | null;
  source: string;
};

type MessageSenderContext = {
  groupId?: string;
  messageId?: string;
  sentAt?: string;
  content?: string;
  rawJson?: string;
};

export type PublicContactProfile = {
  username: string;
  displayName: string;
  remarkName: string;
  nickname: string;
  avatarUrl: string;
  initial: string;
  resolved: boolean;
  subtitle: string;
};

export function upsertContactProfile(input: ContactInput) {
  const username = normalizeUsername(input.username || '');
  if (!username) return;

  const current = db.prepare('SELECT * FROM contact_profiles WHERE username = ?').get(username) as ContactRow | undefined;
  const remarkName = preferHumanName(input.remarkName) || current?.remark_name || '';
  const nickname = preferHumanName(input.nickname) || current?.nickname || '';
  const displayName = preferHumanName(input.displayName)
    || remarkName
    || nickname
    || current?.display_name
    || fallbackDisplayName(username, input.displayName || input.nickname || input.remarkName || '');
  const avatarUrl = firstUrl(input.avatarUrl) || current?.avatar_url || '';

  db.prepare(`
    INSERT INTO contact_profiles (username, remark_name, nickname, display_name, avatar_url, source, raw_json, updated_at)
    VALUES (@username, @remarkName, @nickname, @displayName, @avatarUrl, @source, @rawJson, CURRENT_TIMESTAMP)
    ON CONFLICT(username) DO UPDATE SET
      remark_name = excluded.remark_name,
      nickname = excluded.nickname,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      source = excluded.source,
      raw_json = COALESCE(excluded.raw_json, contact_profiles.raw_json),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    username,
    remarkName,
    nickname,
    displayName,
    avatarUrl,
    source: input.source || current?.source || 'local',
    rawJson: input.rawJson || null
  });
}

export function upsertContactProfileFromRaw(row: AnyRecord, options: { username?: string; fallbackName?: string; source: string }) {
  const username = firstString(row, [
    'username',
    'user_name',
    'wxid',
    'id',
    'from_username',
    'author_username',
    'sender_username',
    'talker'
  ]) || options.username || '';
  const remarkName = firstString(row, [
    'remark',
    'remark_name',
    'contact_remark',
    'contact_display',
    'alias'
  ]);
  const nickname = firstString(row, [
    'nickname',
    'nick_name',
    'display',
    'display_name',
    'group_nickname',
    'name'
  ]);
  const displayName = firstString(row, [
    'contact_display',
    'remark',
    'display_name',
    'display',
    'nickname',
    'nick_name',
    'name',
    'author'
  ]) || options.fallbackName || username;

  upsertContactProfile({
    username,
    remarkName,
    nickname,
    displayName,
    avatarUrl: firstString(row, [
      'avatar',
      'avatar_url',
      'avatarUrl',
      'headimgurl',
      'head_img_url',
      'big_head_img_url',
      'small_head_img_url',
      'portrait'
    ]),
    source: options.source,
    rawJson: JSON.stringify(row)
  });
}

export async function refreshContactProfilesFromWx() {
  try {
    const rows = await wxJson(['contacts', '-n', '5000'], 90_000) as AnyRecord[];
    const tx = db.transaction((items: AnyRecord[]) => {
      for (const row of items) upsertContactProfileFromRaw(row, { source: 'wx-contacts' });
    });
    tx(rows);
    return rows.length;
  } catch {
    return 0;
  }
}

export function refreshContactProfilesFromWxCache() {
  const cacheDir = path.join(os.homedir(), '.wx-cli', 'cache');
  if (!fs.existsSync(cacheDir)) return 0;
  const files = fs.readdirSync(cacheDir)
    .filter((file) => file.endsWith('.db'))
    .map((file) => path.join(cacheDir, file));
  let total = 0;

  for (const file of files) {
    let cacheDb: Database.Database | undefined;
    try {
      cacheDb = new Database(file, { readonly: true, fileMustExist: true });
      const tables = cacheDb.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('contact', 'stranger')
      `).all() as Array<{ name: string }>;
      for (const table of tables) {
        const rows = cacheDb.prepare(`
          SELECT username, remark, nick_name, alias, big_head_url, small_head_url
          FROM ${table.name}
          WHERE username IS NOT NULL AND username <> ''
          LIMIT 20000
        `).all() as AnyRecord[];
        const tx = db.transaction((items: AnyRecord[]) => {
          for (const row of items) {
            upsertContactProfile({
              username: firstString(row, ['username']),
              remarkName: firstString(row, ['remark']),
              nickname: firstString(row, ['nick_name', 'alias']),
              displayName: firstString(row, ['remark', 'nick_name', 'alias', 'username']),
              avatarUrl: firstString(row, ['small_head_url', 'big_head_url']),
              source: `wx-cache-${table.name}`,
              rawJson: JSON.stringify(row)
            });
          }
        });
        tx(rows);
        total += rows.length;
      }
    } catch {
      // Some wx-cli cache shards are message-only databases; ignore them.
    } finally {
      cacheDb?.close();
    }
  }

  return total;
}

export function backfillContactProfilesFromExistingData() {
  const tx = db.transaction(() => {
    const members = db.prepare('SELECT id, name, alias, raw_json AS rawJson FROM members').all() as AnyRecord[];
    for (const row of members) {
      const raw = parseRawJson(String(row.rawJson || ''));
      upsertContactProfileFromRaw(raw, {
        username: String(row.id || row.alias || ''),
        fallbackName: String(row.name || ''),
        source: 'members'
      });
    }

    const sessions = db.prepare("SELECT id, name, raw_json AS rawJson FROM groups WHERE chat_type = 'private'").all() as AnyRecord[];
    for (const row of sessions) {
      const raw = parseRawJson(String(row.rawJson || ''));
      upsertContactProfileFromRaw(raw, {
        username: String(row.id || ''),
        fallbackName: String(row.name || ''),
        source: 'sessions'
      });
    }

    const senders = db.prepare(`
      SELECT sender, MAX(raw_json) AS rawJson
      FROM messages
      WHERE sender <> ''
      GROUP BY sender
      LIMIT 10000
    `).all() as AnyRecord[];
    for (const row of senders) {
      const raw = parseRawJson(String(row.rawJson || ''));
      upsertContactProfileFromRaw(raw, {
        username: String(row.sender || ''),
        fallbackName: String(row.sender || ''),
        source: 'messages'
      });
    }

    const moments = db.prepare('SELECT author, author_username AS authorUsername, raw_json AS rawJson FROM moments').all() as AnyRecord[];
    for (const row of moments) {
      const raw = parseRawJson(String(row.rawJson || ''));
      upsertContactProfileFromRaw(raw, {
        username: String(row.authorUsername || row.author || ''),
        fallbackName: String(row.author || ''),
        source: 'moments'
      });
    }

    const notifications = db.prepare('SELECT author, raw_json AS rawJson FROM moment_notifications').all() as AnyRecord[];
    for (const row of notifications) {
      const raw = parseRawJson(String(row.rawJson || ''));
      upsertContactProfileFromRaw(raw, {
        username: String(row.author || ''),
        fallbackName: String(row.author || ''),
        source: 'moments'
      });
    }
  });
  tx();
}

export function getContactProfile(identifier: string, fallbackName = ''): PublicContactProfile {
  const username = normalizeUsername(identifier || fallbackName);
  const row = username ? findContactRow(username, fallbackName) : undefined;
  const displayName = row
    ? resolveDisplayName(row, fallbackName)
    : fallbackDisplayName(username, fallbackName);
  const remarkName = row?.remark_name || '';
  const nickname = row?.nickname || '';
  const avatarUrl = row?.avatar_url || '';
  const resolved = Boolean(row && hasResolvedName(row));

  return {
    username,
    displayName,
    remarkName,
    nickname,
    avatarUrl,
    initial: firstInitial(displayName),
    resolved,
    subtitle: resolved ? (remarkName ? '备注名' : nickname ? '微信昵称' : row?.source || '本地资料') : '本地资料未解析'
  };
}

export function getMessageSenderProfile(identifier: string, fallbackName = '', context: MessageSenderContext = {}) {
  const raw = parseRawJson(context.rawJson || '');
  const directUsername = firstString(raw, [
    'sender_username',
    'from_username',
    'from_user_name',
    'real_sender',
    'real_sender_username',
    'wxid'
  ]);
  const resolvedUsername = directUsername && isRawIdentifier(directUsername)
    ? directUsername
    : resolveGroupSenderUsername({
      groupId: context.groupId || firstString(raw, ['chat', 'username']),
      messageId: context.messageId || '',
      sentAt: context.sentAt || '',
      content: context.content || firstString(raw, ['content', 'text', 'message']),
      raw
    });

  if (resolvedUsername) return getContactProfile(resolvedUsername, fallbackName || identifier);
  return getContactProfile(identifier, fallbackName);
}

const wxSenderCache = new Map<string, string>();
const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function resolveGroupSenderUsername(context: {
  groupId: string;
  messageId: string;
  sentAt: string;
  content: string;
  raw: AnyRecord;
}) {
  if (!context.groupId?.endsWith('@chatroom')) return '';

  const localId = readLocalId(context.raw, context.content, context.messageId);
  const timestamp = readTimestamp(context.raw, context.sentAt);
  const cacheKey = [
    context.groupId,
    localId || '',
    timestamp || '',
    context.messageId || '',
    cryptoHash(context.content)
  ].join('|');
  if (wxSenderCache.has(cacheKey)) return wxSenderCache.get(cacheKey) || '';

  const resolved = findSenderUsernameInWxCache(localId, timestamp, context.content);
  wxSenderCache.set(cacheKey, resolved);
  return resolved;
}

function findSenderUsernameInWxCache(localId: number, timestamp: number, content: string) {
  for (const file of listWxCacheDatabases()) {
    let cacheDb: Database.Database | undefined;
    try {
      cacheDb = new Database(file, { readonly: true, fileMustExist: true });
      const hasNameTable = Boolean(cacheDb.prepare(`
        SELECT 1 AS ok
        FROM sqlite_master
        WHERE type = 'table' AND name = 'Name2Id'
        LIMIT 1
      `).get());
      if (!hasNameTable) continue;

      const tables = cacheDb.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'Msg_%'
      `).all() as Array<{ name: string }>;

      for (const table of tables) {
        const rows = querySenderRows(cacheDb, table.name, localId, timestamp);
        for (const row of rows) {
          if (!localId && !messageContentMatches(row.message_content, content)) continue;
          const username = senderUsernameById(cacheDb, Number(row.real_sender_id || 0));
          if (username) return username;
        }
      }
    } catch {
      // Ignore non-message cache shards.
    } finally {
      cacheDb?.close();
    }
  }
  return '';
}

function querySenderRows(cacheDb: Database.Database, table: string, localId: number, timestamp: number) {
  try {
    if (localId) {
      const row = cacheDb.prepare(`
        SELECT local_id, real_sender_id, create_time, message_content
        FROM ${quoteIdentifier(table)}
        WHERE local_id = ?
        LIMIT 1
      `).get(localId) as AnyRecord | undefined;
      return row ? [row] : [];
    }
    if (!timestamp) return [];
    return cacheDb.prepare(`
      SELECT local_id, real_sender_id, create_time, message_content
      FROM ${quoteIdentifier(table)}
      WHERE create_time BETWEEN ? AND ?
      ORDER BY local_id DESC
      LIMIT 20
    `).all(timestamp - 1, timestamp + 1) as AnyRecord[];
  } catch {
    return [];
  }
}

function senderUsernameById(cacheDb: Database.Database, senderId: number) {
  if (!senderId) return '';
  try {
    const row = cacheDb.prepare('SELECT user_name FROM Name2Id WHERE rowid = ?').get(senderId) as { user_name?: string } | undefined;
    return row?.user_name || '';
  } catch {
    return '';
  }
}

function messageContentMatches(value: unknown, content: string) {
  const needle = content.trim();
  if (!needle) return true;
  const decoded = decodeMessageContent(value);
  if (!decoded) return false;
  if (decoded.includes(needle)) return true;
  const compactNeedle = needle.replace(/\s+/g, ' ').slice(0, 80);
  return Boolean(compactNeedle && decoded.replace(/\s+/g, ' ').includes(compactNeedle));
}

function decodeMessageContent(value: unknown) {
  if (!value) return '';
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  try {
    const decoded = buffer.subarray(0, 4).equals(zstdMagic) ? zstdDecompressSync(buffer) : buffer;
    return decoded.toString('utf8');
  } catch {
    return '';
  }
}

function listWxCacheDatabases() {
  const cacheDir = path.join(os.homedir(), '.wx-cli', 'cache');
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir)
    .filter((file) => file.endsWith('.db'))
    .map((file) => path.join(cacheDir, file));
}

function readLocalId(raw: AnyRecord, content: string, id: string) {
  const direct = raw.local_id ?? raw.localId ?? raw.id;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
  const match = content.match(/local_id=(\d+)/i);
  if (match) return Number(match[1]);
  return /^\d+$/.test(id) ? Number(id) : 0;
}

function readTimestamp(raw: AnyRecord, sentAt: string) {
  const direct = raw.timestamp ?? raw.create_time ?? raw.createTime;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct > 10_000_000_000 ? Math.floor(direct / 1000) : direct;
  if (typeof direct === 'string' && /^\d+$/.test(direct)) {
    const value = Number(direct);
    return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  }
  const parsed = new Date(sentAt).getTime();
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function cryptoHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return String(hash);
}

function findContactRow(username: string, fallbackName: string) {
  const exact = db.prepare('SELECT * FROM contact_profiles WHERE username = ?').get(username) as ContactRow | undefined;
  if (exact) return exact;
  const humanFallback = preferHumanName(fallbackName);
  if (!humanFallback) return undefined;
  return db.prepare(`
    SELECT *
    FROM contact_profiles
    WHERE display_name = ? OR remark_name = ? OR nickname = ?
    LIMIT 1
  `).get(humanFallback, humanFallback, humanFallback) as ContactRow | undefined;
}

function resolveDisplayName(row: ContactRow, fallbackName: string) {
  return preferHumanName(row.remark_name || '')
    || preferHumanName(row.nickname || '')
    || preferHumanName(row.display_name)
    || fallbackDisplayName(row.username, fallbackName);
}

function hasResolvedName(row: ContactRow) {
  const name = preferHumanName(row.remark_name || '')
    || preferHumanName(row.nickname || '')
    || preferHumanName(row.display_name);
  return Boolean(name && name !== '微信联系人');
}

function fallbackDisplayName(username: string, fallbackName = '') {
  return preferHumanName(fallbackName) || (isRawIdentifier(username) ? '微信联系人' : username || '未知联系人');
}

function preferHumanName(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || isRawIdentifier(text)) return '';
  return text;
}

function normalizeUsername(value: string) {
  return String(value || '').trim();
}

function isRawIdentifier(value: string) {
  const text = value.trim();
  if (!text) return true;
  return /^wxid_/i.test(text)
    || /@chatroom$/i.test(text)
    || /@openim$/i.test(text)
    || /^gh_/i.test(text)
    || /^\d{8,}$/.test(text);
}

function firstInitial(value: string) {
  const chars = Array.from(value.trim());
  return (chars[0] || '微').toUpperCase();
}

function firstUrl(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//i.test(text) || text.startsWith('/') ? text : '';
}

function firstString(row: AnyRecord, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function parseRawJson(value: string) {
  try {
    return value ? JSON.parse(value) as AnyRecord : {};
  } catch {
    return {};
  }
}
