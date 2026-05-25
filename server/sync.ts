import crypto from 'node:crypto';
import { refreshContactProfilesFromWx, refreshContactProfilesFromWxCache, upsertContactProfileFromRaw } from './contacts.js';
import { db, resetChatTypeData, resetMomentsData } from './db.js';
import { getWxCacheGroupName, isPlaceholderGroupName, refreshGroupNamesFromWxCache } from './groupNames.js';
import { applyAutoCollections } from './groups.js';
import { rebuildSignals } from './rules.js';
import type { SyncStatus } from './types.js';
import { wxJson } from './wx.js';

export type SyncScope = 'group' | 'private' | 'moments' | 'media' | 'all';
type ChatType = 'group' | 'private';
type AnyRecord = Record<string, unknown>;

let status: SyncStatus = { running: false, phase: 'idle' };
let autoTimer: NodeJS.Timeout | undefined;

export function getSyncStatus() {
  return status;
}

export async function startFullSync(days = 30, explicitSince?: string, explicitUntil?: string, scope: SyncScope = 'group') {
  if (status.running) return status;

  const { since, until } = normalizeSyncRange(days, explicitSince, explicitUntil);
  const normalizedScope = normalizeScope(scope);
  const run = db.prepare(`
    INSERT INTO sync_runs (mode, since, until, status, started_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`full:${normalizedScope}`, since, until, 'running', new Date().toISOString());

  status = {
    running: true,
    runId: Number(run.lastInsertRowid),
    phase: '准备同步',
    startedAt: new Date().toISOString(),
    processedGroups: 0
  };

  void performFullSync(Number(run.lastInsertRowid), since, until, normalizedScope);
  return status;
}

export function startAutoIncrementalSync(intervalMs = 5 * 60 * 1000) {
  if (autoTimer) return;
  autoTimer = setInterval(() => {
    if (!status.running) void performIncrementalSync('group');
  }, intervalMs);
}

export async function performIncrementalSync(scope: SyncScope = 'group') {
  if (status.running) return status;

  const normalizedScope = normalizeScope(scope);
  status = {
    running: true,
    phase: labelPhase(normalizedScope, '增量同步'),
    startedAt: new Date().toISOString()
  };

  try {
    if (normalizedScope === 'moments') {
      const until = toDateString(new Date());
      const since = toDateString(addDays(new Date(), -7));
      await syncMoments(since, until, false);
    } else {
      const rows = (await wxJson(['new-messages', '-n', '500'], 60_000)) as AnyRecord[];
      const chatTypes = chatTypesForScope(normalizedScope);
      for (const chatType of chatTypes) {
        const sessions = new Map<string, ReturnType<typeof normalizeSession>>();
        for (const row of rows) {
          const session = normalizeSession(messageToSession(row), chatType);
          if (matchesChatType({ ...row, ...session.raw, chat_type: row.chat_type ?? row.chatType ?? session.chatType }, chatType)) {
            sessions.set(session.id, session);
          }
        }
        for (const session of sessions.values()) upsertSession(session);
        for (const row of rows) {
          const session = normalizeSession(messageToSession(row), chatType);
          if (sessions.has(session.id)) insertMessages(session, [row]);
        }
      }
      if (chatTypes.includes('group')) refreshGroupNamesFromWxCache();
      applyAutoCollections();
      rebuildSignals();
      if (normalizedScope === 'media') {
        const until = toDateString(new Date());
        const since = toDateString(addDays(new Date(), -7));
        await syncMoments(since, until, false);
      }
    }
    status = { running: false, phase: 'idle', finishedAt: new Date().toISOString() };
  } catch (error) {
    status = {
      running: false,
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString()
    };
  }

  return status;
}

async function performFullSync(runId: number, since: string, until: string, scope: SyncScope) {
  try {
    await refreshContactProfilesFromWx();
    refreshContactProfilesFromWxCache();

    if (scope === 'group' || scope === 'private' || scope === 'media' || scope === 'all') {
      const sessions = (await wxJson(['sessions', '-n', '1000'], 90_000)) as AnyRecord[];
      for (const chatType of chatTypesForScope(scope)) {
        await syncChatSessions(sessions, chatType, since, until, true);
      }
    }

    if (scope === 'moments' || scope === 'media' || scope === 'all') {
      await syncMoments(since, until, true);
    }

    db.prepare('UPDATE sync_runs SET status = ?, finished_at = ? WHERE id = ?')
      .run('success', new Date().toISOString(), runId);
    status = { ...status, running: false, phase: 'done', finishedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare('UPDATE sync_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?')
      .run('failed', new Date().toISOString(), message, runId);
    status = { ...status, running: false, phase: 'failed', error: message, finishedAt: new Date().toISOString() };
  }
}

async function syncChatSessions(sessions: AnyRecord[], chatType: ChatType, since: string, until: string, reset: boolean) {
  if (reset) resetChatTypeData(chatType);

  const filtered = sessions.filter((session) => matchesChatType(session, chatType));
  const limited = chatType === 'private' ? filtered.slice(0, 80) : filtered;
  status = {
    ...status,
    totalGroups: limited.length,
    processedGroups: 0,
    phase: chatType === 'group' ? '同步群聊消息' : '同步近期私聊'
  };

  for (const rawSession of limited) {
    const session = normalizeSession(rawSession, chatType);
    status = { ...status, current: session.name };
    upsertSession(session);

    try {
      const limit = chatType === 'private' ? '3000' : '5000';
      const history = (await wxJson(['history', session.id, '--since', since, '--until', until, '-n', limit], 120_000)) as AnyRecord[];
      insertMessages(session, history);
    } catch (error) {
      console.warn(`history failed: ${session.name}`, error);
    }

    if (chatType === 'group') {
      try {
        const members = (await wxJson(['members', session.id], 60_000)) as AnyRecord[];
        insertMembers(session.id, members);
      } catch {
        // 群成员不是核心数据，失败不阻断同步。
      }
    }

    status = { ...status, processedGroups: (status.processedGroups || 0) + 1 };
  }

  if (chatType === 'group') {
    status = { ...status, phase: '补齐群名' };
    refreshGroupNamesFromWxCache();
    applyAutoCollections();
  }

  status = { ...status, phase: '构建本地规则情报' };
  rebuildSignals();
}

async function syncMoments(since: string, until: string, reset: boolean) {
  if (reset) resetMomentsData();
  status = { ...status, phase: '同步朋友圈内容', current: '朋友圈时间线' };

  const feed = (await wxJson(['sns-feed', '--since', since, '--until', until, '-n', '1000'], 90_000)) as AnyRecord[];
  insertMoments(feed);

  status = { ...status, phase: '同步朋友圈互动', current: '朋友圈互动通知' };
  const notifications = (await wxJson(['sns-notifications', '--since', since, '--until', until, '--include-read', '-n', '500'], 90_000)) as AnyRecord[];
  insertMomentNotifications(notifications);
}

function upsertSession(session: ReturnType<typeof normalizeSession>) {
  const current = db.prepare('SELECT name, collection FROM groups WHERE id = ?').get(session.id) as {
    name: string;
    collection: string;
  } | undefined;
  const effectiveSession = { ...session };
  if (session.chatType === 'group' && current && isPlaceholderGroupName(effectiveSession.name, effectiveSession.id) && !isPlaceholderGroupName(current.name, effectiveSession.id)) {
    effectiveSession.name = current.name;
    effectiveSession.collection = current.collection || effectiveSession.collection;
  }

  db.prepare(`
    INSERT INTO groups (id, name, chat_type, collection, member_count, last_message_at, raw_json)
    VALUES (@id, @name, @chatType, @collection, @memberCount, @lastMessageAt, @rawJson)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      chat_type = excluded.chat_type,
      collection = excluded.collection,
      member_count = excluded.member_count,
      last_message_at = excluded.last_message_at,
      raw_json = excluded.raw_json
  `).run(effectiveSession);

  if (effectiveSession.chatType === 'private') {
    upsertContactProfileFromRaw(effectiveSession.raw, {
      username: effectiveSession.id,
      fallbackName: effectiveSession.name,
      source: 'sessions'
    });
  }
}

function insertMessages(session: ReturnType<typeof normalizeSession>, rows: AnyRecord[]) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, group_id, group_name, sender, sent_at, type, content, mentions_me, has_link, raw_json)
    VALUES
      (@id, @groupId, @groupName, @sender, @sentAt, @type, @content, @mentionsMe, @hasLink, @rawJson)
  `);

  const tx = db.transaction((messages: AnyRecord[]) => {
    for (const row of messages) {
      const content = firstString(row, ['content', 'text', 'message', 'msg', 'body', 'summary']) || '';
      const sentAt = normalizeTime(row.sent_at ?? row.create_time ?? row.timestamp ?? row.time) || new Date().toISOString();
      const sender = firstString(row, ['sender', 'sender_name', 'from', 'from_name', 'talker', 'nickname', 'last_sender']) || (session.chatType === 'private' ? session.name : '未知成员');
      const type = firstString(row, ['type', 'msg_type', 'message_type', 'last_msg_type']) || 'text';
      const rawId = firstString(row, ['id', 'msg_id', 'message_id', 'local_id']);
      const id = rawId ? scopedMessageId(session.id, rawId) : stableId(`${session.id}|${sender}|${sentAt}|${content}`);
      const mentionsMe = /@我|@所有人|@all/i.test(content) || Boolean(row.mentions_me ?? row.is_at_me);
      const hasLink = /(https?:\/\/|www\.|github\.com|\.com|\.ai|\.dev|\.cn)/i.test(content) || typeof row.url === 'string';
      insert.run({
        id,
        groupId: session.id,
        groupName: session.name,
        sender,
        sentAt,
        type,
        content,
        mentionsMe: mentionsMe ? 1 : 0,
        hasLink: hasLink ? 1 : 0,
        rawJson: JSON.stringify(row)
      });

      upsertContactProfileFromRaw(row, {
        username: sender || (session.chatType === 'private' ? session.id : ''),
        fallbackName: sender || (session.chatType === 'private' ? session.name : ''),
        source: 'messages'
      });
    }
  });

  tx(rows);
}

function insertMembers(groupId: string, rows: AnyRecord[]) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO members (id, group_id, name, alias, raw_json)
    VALUES (@id, @groupId, @name, @alias, @rawJson)
  `);

  const tx = db.transaction((members: AnyRecord[]) => {
    for (const row of members) {
      const name = firstString(row, ['name', 'nickname', 'display_name', 'remark', 'username']) || '未命名成员';
      const alias = firstString(row, ['alias', 'remark', 'wxid']);
      const id = firstString(row, ['id', 'username', 'wxid']) || stableId(`${groupId}|${name}`);
      insert.run({ id, groupId, name, alias, rawJson: JSON.stringify(row) });
      upsertContactProfileFromRaw(row, {
        username: id,
        fallbackName: name,
        source: 'members'
      });
    }
  });

  tx(rows);
}

function insertMoments(rows: AnyRecord[]) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO moments
      (id, author, author_username, content, sent_at, media_json, media_count, location, raw_json)
    VALUES
      (@id, @author, @authorUsername, @content, @sentAt, @mediaJson, @mediaCount, @location, @rawJson)
  `);

  const tx = db.transaction((items: AnyRecord[]) => {
    for (const row of items) {
      const id = firstString(row, ['tid', 'id']) || stableId(JSON.stringify(row));
      const media = row.media;
      const author = firstString(row, ['author', 'from', 'name']) || '未知作者';
      const authorUsername = firstString(row, ['author_username', 'username', 'wxid']);
      insert.run({
        id,
        author,
        authorUsername,
        content: firstString(row, ['content', 'text', 'preview']) || '',
        sentAt: normalizeTime(row.timestamp ?? row.time ?? row.sent_at) || new Date().toISOString(),
        mediaJson: JSON.stringify(Array.isArray(media) ? media : media ? [media] : []),
        mediaCount: Number(row.media_count ?? (Array.isArray(media) ? media.length : media ? 1 : 0)) || 0,
        location: stringifyOptional(row.location),
        rawJson: JSON.stringify(row)
      });
      upsertContactProfileFromRaw(row, {
        username: authorUsername || author,
        fallbackName: author,
        source: 'moments'
      });
    }
  });

  tx(rows);
}

function insertMomentNotifications(rows: AnyRecord[]) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO moment_notifications
      (id, author, content, sent_at, type, raw_json)
    VALUES
      (@id, @author, @content, @sentAt, @type, @rawJson)
  `);

  const tx = db.transaction((items: AnyRecord[]) => {
    for (const row of items) {
      const content = firstString(row, ['content', 'text', 'preview', 'comment']) || '';
      const author = firstString(row, ['author', 'from', 'name', 'nickname']) || '未知互动';
      const sentAt = normalizeTime(row.timestamp ?? row.time ?? row.sent_at) || new Date().toISOString();
      insert.run({
        id: firstString(row, ['id', 'tid', 'notification_id']) || stableId(`${author}|${sentAt}|${content}`),
        author,
        content,
        sentAt,
        type: firstString(row, ['type', 'action']) || '互动',
        rawJson: JSON.stringify(row)
      });
      upsertContactProfileFromRaw(row, {
        username: firstString(row, ['author_username', 'username', 'wxid']) || author,
        fallbackName: author,
        source: 'moments'
      });
    }
  });

  tx(rows);
}

function normalizeSession(row: AnyRecord, chatType: ChatType) {
  const id = firstString(row, ['username', 'id', 'chat_id', 'user_name', 'wxid', 'chat', 'room_id']) || stableId(JSON.stringify(row));
  const rawName = firstString(row, [
    'chat',
    'name',
    'nickname',
    'nick_name',
    'display',
    'display_name',
    'remark',
    'title',
    'chat_name',
    'room_name',
    'session_name',
    'talker_name'
  ]);
  const resolvedName = chatType === 'group' ? getWxCacheGroupName(id) : '';
  const name = resolvedName || (chatType === 'group' && isPlaceholderGroupName(rawName, id) ? '未命名群' : rawName || id);
  const lastMessageAt = normalizeTime(row.last_message_at ?? row.last_time ?? row.update_time ?? row.timestamp ?? row.time);
  return {
    id,
    name,
    chatType,
    collection: chatType === 'group' ? inferCollection(name) : '私聊',
    memberCount: Number(row.member_count ?? row.members_count ?? 0) || 0,
    lastMessageAt,
    rawJson: JSON.stringify(row),
    raw: row
  };
}

function matchesChatType(row: AnyRecord, chatType: ChatType) {
  const explicitType = String(row.chat_type ?? row.chatType ?? row.type ?? '').toLowerCase();
  const username = firstString(row, ['username', 'user_name', 'chat_id', 'id', 'wxid', 'chat']);
  const isGroup = Boolean(row.is_group ?? row.isGroup) || username.includes('@chatroom') || explicitType === 'group';
  if (chatType === 'group') return isGroup;
  return !isGroup && isPersonalChatId(username);
}

function isPersonalChatId(username: string) {
  const value = username.toLowerCase();
  if (!value || value.startsWith('@') || value.includes('@chatroom')) return false;
  if (value.startsWith('gh_')) return false;
  const blocked = new Set([
    'qqmail',
    'fmessage',
    'filehelper',
    'medianote',
    'floatbottle',
    'weixin',
    'notifymessage',
    'brandsessionholder',
    'brandservicesessionholder',
    'officialaccounts',
    'newsapp',
    'feedsapp',
    'mphelper',
    'masssendapp',
    'voiceinputapp',
    'lbsapp',
    'shakeapp',
    'cardpackage'
  ]);
  return !blocked.has(value);
}

function chatTypesForScope(scope: SyncScope): ChatType[] {
  if (scope === 'private') return ['private'];
  if (scope === 'all' || scope === 'media') return ['group', 'private'];
  return scope === 'group' ? ['group'] : [];
}

function normalizeScope(scope: string): SyncScope {
  if (scope === 'private' || scope === 'moments' || scope === 'media' || scope === 'all') return scope;
  return 'group';
}

function labelPhase(scope: SyncScope, label: string) {
  const prefix: Record<SyncScope, string> = {
    group: '群萃',
    private: '私萃',
    moments: '圈萃',
    media: '影萃',
    all: '全量'
  };
  return `${prefix[scope]} · ${label}`;
}

function firstString(row: AnyRecord, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function normalizeTime(value: unknown) {
  if (typeof value === 'number') {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return value;
  }
  return null;
}

function stableId(input: string) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function scopedMessageId(sessionId: string, rawId: string) {
  return stableId(`${sessionId}|${rawId}`);
}

function toDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeSyncRange(days: number, since?: string, until?: string) {
  const end = isDateOnly(until) ? new Date(`${until}T00:00:00`) : new Date();
  const start = isDateOnly(since)
    ? new Date(`${since}T00:00:00`)
    : new Date(end.getTime() - (Math.max(1, days) - 1) * 24 * 60 * 60 * 1000);
  if (start.getTime() <= end.getTime()) return { since: toDateString(start), until: toDateString(end) };
  return { since: toDateString(end), until: toDateString(start) };
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isDateOnly(value?: string) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function stringifyOptional(value: unknown) {
  if (!value) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function inferCollection(name: string) {
  if (/产品|工具|用户/.test(name)) return 'AI 产品虫虫团';
  if (/AGI|Agent|Wayto/i.test(name)) return 'WaytoAGI';
  if (/Coding|编程|开发/.test(name)) return 'Vibe Coding';
  if (/学术|论文|研究/.test(name)) return 'AI 学术';
  if (/商业|营销|增长/.test(name)) return 'AI 商业·营销';
  if (/内容|AIGC|创作/.test(name)) return 'AIGC 内容创作';
  return '未分组';
}

function messageToSession(row: AnyRecord): AnyRecord {
  const sessionName = firstString(row, ['group_name', 'chat_name', 'room_name', 'session_name', 'chat', 'name', 'talker_name']) || '未命名会话';
  const id = firstString(row, ['group_id', 'chat_id', 'room_id', 'talker', 'username', 'wxid']) || sessionName;
  return {
    id,
    chat_id: id,
    username: id,
    chat: sessionName,
    name: sessionName,
    chat_type: row.chat_type ?? row.chatType ?? (String(id).includes('@chatroom') ? 'group' : 'private'),
    timestamp: row.sent_at ?? row.create_time ?? row.timestamp ?? row.time
  };
}
