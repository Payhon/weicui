import { db } from './db.js';
import { toMessage } from './groups.js';

type MediaParams = {
  since?: string;
  until?: string;
  source?: string;
  type?: string;
  chatId?: string;
  sender?: string;
  query?: string;
};

export function getMediaLibrary(params: MediaParams) {
  const range = normalizeRange(params.since, params.until);
  const where = buildWhere(range, params);
  const rows = db.prepare(`
    SELECT
      m.id,
      m.group_id AS groupId,
      g.name AS chatName,
      g.chat_type AS chatType,
      m.sender,
      m.sent_at AS sentAt,
      m.type,
      m.content,
      m.mentions_me AS mentionsMe,
      m.has_link AS hasLink,
      m.raw_json AS rawJson
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    WHERE ${where.sql}
    ORDER BY datetime(m.sent_at) DESC
    LIMIT 400
  `).all(...where.args) as Array<Record<string, unknown>>;

  return {
    range,
    source: normalizeSource(params.source),
    type: normalizeType(params.type),
    total: rows.length,
    metrics: readMetrics(range),
    items: rows.map((row) => ({
      ...toMessage(row),
      chatId: String(row.groupId),
      chatName: String(row.chatName || ''),
      chatType: String(row.chatType || 'group'),
      sourceLabel: String(row.chatType) === 'private' ? '私萃' : '群萃'
    }))
  };
}

function buildWhere(range: { since: string; until: string }, params: MediaParams) {
  const parts = ['date(m.sent_at) BETWEEN ? AND ?'];
  const args: unknown[] = [range.since, range.until];
  const source = normalizeSource(params.source);
  const type = normalizeType(params.type);

  if (source !== 'all') {
    parts.push('g.chat_type = ?');
    args.push(source === 'private' ? 'private' : 'group');
  } else {
    parts.push("g.chat_type IN ('group', 'private')");
  }

  if (type === 'image') parts.push("(m.type LIKE '%图片%' OR m.content LIKE '%[图片]%')");
  if (type === 'video') parts.push("(m.type LIKE '%视频%' OR m.content LIKE '%[视频]%')");
  if (type === 'all') parts.push("((m.type LIKE '%图片%' OR m.content LIKE '%[图片]%') OR (m.type LIKE '%视频%' OR m.content LIKE '%[视频]%'))");

  if (params.chatId) {
    parts.push('m.group_id = ?');
    args.push(params.chatId);
  }
  if (params.sender?.trim()) {
    parts.push(`(
      m.sender LIKE ? OR EXISTS (
        SELECT 1 FROM contact_profiles cp
        WHERE cp.username = m.sender
          AND (cp.display_name LIKE ? OR cp.remark_name LIKE ? OR cp.nickname LIKE ?)
      )
    )`);
    const like = `%${params.sender.trim()}%`;
    args.push(like, like, like, like);
  }
  if (params.query?.trim()) {
    parts.push(`(
      m.content LIKE ? OR g.name LIKE ? OR m.sender LIKE ? OR EXISTS (
        SELECT 1 FROM contact_profiles cp
        WHERE cp.username = m.sender
          AND (cp.display_name LIKE ? OR cp.remark_name LIKE ? OR cp.nickname LIKE ?)
      )
    )`);
    const like = `%${params.query.trim()}%`;
    args.push(like, like, like, like, like, like);
  }

  return { sql: parts.join(' AND '), args };
}

function readMetrics(range: { since: string; until: string }) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN m.type LIKE '%图片%' OR m.content LIKE '%[图片]%' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN m.type LIKE '%视频%' OR m.content LIKE '%[视频]%' THEN 1 ELSE 0 END) AS videos,
      COUNT(DISTINCT m.group_id) AS chats,
      COUNT(DISTINCT m.sender) AS senders
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    WHERE g.chat_type IN ('group', 'private') AND date(m.sent_at) BETWEEN ? AND ?
  `).get(range.since, range.until) as Record<string, unknown>;
  return {
    images: Number(row.images || 0),
    videos: Number(row.videos || 0),
    chats: Number(row.chats || 0),
    senders: Number(row.senders || 0)
  };
}

function normalizeSource(source?: string) {
  return source === 'group' || source === 'private' || source === 'all' ? source : 'all';
}

function normalizeType(type?: string) {
  return type === 'image' || type === 'video' || type === 'all' ? type : 'all';
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}
