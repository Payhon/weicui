import { db } from './db.js';
import { wxJson } from './wx.js';

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
