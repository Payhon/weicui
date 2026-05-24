import { getContactProfile } from './contacts.js';
import { db } from './db.js';

type MomentParams = {
  since?: string;
  until?: string;
  query?: string;
  author?: string;
};

export function getMoments(params: MomentParams) {
  const range = normalizeRange(params.since, params.until);
  const where = buildMomentWhere(range, params.query || '', params.author || '');
  const rows = db.prepare(`
    SELECT id, author, author_username AS authorUsername, content, sent_at AS sentAt, media_json AS mediaJson, media_count AS mediaCount, location
    FROM moments
    WHERE ${where.sql}
    ORDER BY datetime(sent_at) DESC
    LIMIT 240
  `).all(...where.args) as Array<Record<string, unknown>>;

  return {
    range,
    query: params.query || '',
    author: params.author || '',
    total: count(`SELECT COUNT(*) AS count FROM moments WHERE ${where.sql}`, where.args),
    metrics: readMomentMetrics(range),
    authors: readAuthors(range),
    items: rows.map(toMoment)
  };
}

export function searchMoments(params: MomentParams) {
  return getMoments(params);
}

export function getMomentNotifications(params: Pick<MomentParams, 'since' | 'until'>) {
  const range = normalizeRange(params.since, params.until);
  const rows = db.prepare(`
    SELECT id, author, content, sent_at AS sentAt, type
    FROM moment_notifications
    WHERE date(sent_at) BETWEEN ? AND ?
    ORDER BY datetime(sent_at) DESC
    LIMIT 120
  `).all(range.since, range.until) as Array<Record<string, unknown>>;

  return {
    range,
    total: rows.length,
    items: rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      author: getContactProfile(String(row.author || ''), String(row.author || '')).displayName,
      authorProfile: getContactProfile(String(row.author || ''), String(row.author || '')),
      content: String(row.content || ''),
      type: String(row.type || '互动'),
      time: formatDateTime(String(row.sentAt || ''))
    }))
  };
}

function buildMomentWhere(range: { since: string; until: string }, query: string, author: string) {
  const parts = ['date(sent_at) BETWEEN ? AND ?'];
  const args: unknown[] = [range.since, range.until];
  if (query.trim()) {
    parts.push(`(
      content LIKE ? OR author LIKE ? OR author_username LIKE ? OR EXISTS (
        SELECT 1 FROM contact_profiles cp
        WHERE cp.username = moments.author_username
          AND (cp.display_name LIKE ? OR cp.remark_name LIKE ? OR cp.nickname LIKE ?)
      )
    )`);
    const like = `%${query.trim()}%`;
    args.push(like, like, like, like, like, like);
  }
  if (author.trim()) {
    parts.push(`(
      author LIKE ? OR author_username LIKE ? OR EXISTS (
        SELECT 1 FROM contact_profiles cp
        WHERE cp.username = moments.author_username
          AND (cp.display_name LIKE ? OR cp.remark_name LIKE ? OR cp.nickname LIKE ?)
      )
    )`);
    const like = `%${author.trim()}%`;
    args.push(like, like, like, like, like);
  }
  return { sql: parts.join(' AND '), args };
}

function readMomentMetrics(range: { since: string; until: string }) {
  const row = db.prepare(`
    SELECT COUNT(*) AS posts, COUNT(DISTINCT author) AS authors, SUM(media_count) AS media
    FROM moments
    WHERE date(sent_at) BETWEEN ? AND ?
  `).get(range.since, range.until) as Record<string, unknown>;
  const notifications = count(`
    SELECT COUNT(*) AS count
    FROM moment_notifications
    WHERE date(sent_at) BETWEEN ? AND ?
  `, [range.since, range.until]);

  return {
    posts: Number(row.posts || 0),
    authors: Number(row.authors || 0),
    media: Number(row.media || 0),
    notifications
  };
}

function readAuthors(range: { since: string; until: string }) {
  return (db.prepare(`
    SELECT author AS name, author_username AS username, COUNT(*) AS count, MAX(sent_at) AS lastTime
    FROM moments
    WHERE date(sent_at) BETWEEN ? AND ?
    GROUP BY COALESCE(author_username, author)
    ORDER BY count DESC, datetime(lastTime) DESC
    LIMIT 20
  `).all(range.since, range.until) as Array<Record<string, unknown>>).map((row) => ({
    name: getContactProfile(String(row.username || row.name || ''), String(row.name || '')).displayName,
    username: String(row.username || row.name || ''),
    profile: getContactProfile(String(row.username || row.name || ''), String(row.name || '')),
    count: Number(row.count || 0),
    lastTime: formatDateTime(String(row.lastTime || ''))
  }));
}

function toMoment(row: Record<string, unknown>) {
  const author = String(row.author || '未知作者');
  const authorUsername = String(row.authorUsername || author);
  const authorProfile = getContactProfile(authorUsername, author);
  return {
    id: String(row.id),
    author: authorProfile.displayName,
    authorName: authorProfile.displayName,
    authorRaw: author,
    authorUsername,
    authorProfile,
    content: String(row.content || ''),
    time: formatDateTime(String(row.sentAt || '')),
    absoluteTime: String(row.sentAt || ''),
    media: parseJsonArray(String(row.mediaJson || '[]')),
    mediaCount: Number(row.mediaCount || 0),
    location: String(row.location || '')
  };
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}

function count(sql: string, args: unknown[] = []) {
  return ((db.prepare(sql).get(...args) as { count: number } | undefined)?.count ?? 0);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}
