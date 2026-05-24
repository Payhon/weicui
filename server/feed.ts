import { getContactProfile } from './contacts.js';
import { db } from './db.js';
import type { DashboardRange } from './types.js';

export type FeedKind = 'all' | 'signals' | 'actions' | 'mentions' | 'links';

export type FeedItem = {
  id: string;
  rank: number;
  title: string;
  groupName: string;
  sender: string;
  time: string;
  absoluteTime: string;
  type: string;
  tags: string[];
  score: number;
  kind: 'message' | 'signal' | 'action';
  content: string;
  hasLink: boolean;
  mentionsMe: boolean;
};

export type FeedResponse = {
  range: DashboardRange;
  kind: FeedKind;
  query: string;
  limit: number;
  offset: number;
  total: number;
  stats: {
    messages: number;
    signals: number;
    actions: number;
    mentions: number;
    links: number;
  };
  items: FeedItem[];
  groups: Array<{ name: string; count: number; lastTime: string }>;
  types: Array<{ name: string; count: number }>;
  scope: FeedScope;
};

export type FeedScope = {
  type: 'all' | 'favorite' | 'ungrouped' | 'collection' | 'group';
  value: string;
  label: string;
};

type CountRow = { count: number };
type FeedRow = {
  id: string;
  groupName: string;
  sender: string;
  sentAt: string;
  type: string;
  content: string;
  mentionsMe: number;
  hasLink: number;
  signalKind: string | null;
  score: number | null;
  title: string | null;
  tags: string | null;
};

export function getFeed(params: {
  since?: string;
  until?: string;
  kind?: string;
  query?: string;
  limit?: number;
  offset?: number;
  scope?: string;
  scopeValue?: string;
}): FeedResponse {
  const range = normalizeRange(params.since, params.until);
  const kind = normalizeKind(params.kind);
  const scope = normalizeScope(params.scope, params.scopeValue);
  const query = (params.query || '').trim();
  const limit = clamp(Number(params.limit || 80), 20, 200);
  const offset = Math.max(0, Number(params.offset || 0));

  const where = buildWhere(range, kind, query, scope);
  const rows = db.prepare(`
    SELECT
      m.id,
      m.group_name AS groupName,
      m.sender,
      m.sent_at AS sentAt,
      m.type,
      m.content,
      m.mentions_me AS mentionsMe,
      m.has_link AS hasLink,
      s.kind AS signalKind,
      s.score,
      s.title,
      s.tags
    FROM messages m
    LEFT JOIN groups g ON g.id = m.group_id
    LEFT JOIN signals s ON s.message_id = m.id
    ${where.sql}
    ORDER BY m.sent_at DESC, COALESCE(s.score, 0) DESC
    LIMIT ? OFFSET ?
  `).all(...where.args, limit, offset) as FeedRow[];

  return {
    range,
    kind,
    query,
    limit,
    offset,
    total: count(`
      SELECT COUNT(*) AS count
      FROM messages m
      LEFT JOIN groups g ON g.id = m.group_id
      LEFT JOIN signals s ON s.message_id = m.id
      ${where.sql}
    `, where.args),
    stats: {
      messages: countScoped(range, '1 = 1', scope),
      signals: count(`
        SELECT COUNT(*) AS count FROM signals s
        JOIN messages m ON m.id = s.message_id
        LEFT JOIN groups g ON g.id = m.group_id
        ${buildWhere(range, 'signals', '', scope).sql}
      `, buildWhere(range, 'signals', '', scope).args),
      actions: count(`
        SELECT COUNT(*) AS count FROM signals s
        JOIN messages m ON m.id = s.message_id
        LEFT JOIN groups g ON g.id = m.group_id
        ${buildWhere(range, 'actions', '', scope).sql}
      `, buildWhere(range, 'actions', '', scope).args),
      mentions: countScoped(range, 'm.mentions_me = 1', scope),
      links: countScoped(range, 'm.has_link = 1', scope)
    },
    items: rows.map((row, index) => toFeedItem(row, offset + index + 1)),
    groups: readGroups(range, query, scope),
    types: readTypes(range, scope),
    scope
  };
}

function buildWhere(range: DashboardRange, kind: FeedKind, query: string, scope: FeedScope = normalizeScope()) {
  const parts = ['date(m.sent_at) BETWEEN ? AND ?'];
  const args: unknown[] = [range.since, range.until];

  if (kind === 'signals') parts.push("s.kind = 'signal'");
  if (kind === 'actions') parts.push("s.kind = 'action'");
  if (kind === 'mentions') parts.push('m.mentions_me = 1');
  if (kind === 'links') parts.push('m.has_link = 1');
  appendScope(parts, args, scope);

  if (query) {
    parts.push('(m.content LIKE ? OR m.group_name LIKE ? OR m.sender LIKE ?)');
    const like = `%${query}%`;
    args.push(like, like, like);
  }

  return {
    sql: `WHERE ${parts.join(' AND ')}`,
    args
  };
}

function toFeedItem(row: FeedRow, rank: number): FeedItem {
  const content = row.content || '';
  const kind = row.signalKind === 'action' ? 'action' : row.signalKind === 'signal' ? 'signal' : 'message';
  const tags = parseTags(row.tags);
  if (row.hasLink && !tags.includes('链接信号')) tags.push('链接信号');
  if (row.mentionsMe && !tags.includes('@我')) tags.push('@我');
  if (!tags.includes(row.type)) tags.push(row.type);

  return {
    id: row.id,
    rank,
    title: row.title || compactTitle(content),
    groupName: row.groupName,
    sender: getContactProfile(row.sender, row.sender).displayName,
    time: formatRelative(row.sentAt),
    absoluteTime: formatDateTime(row.sentAt),
    type: row.type,
    tags: tags.slice(0, 5),
    score: Number(row.score || 0),
    kind,
    content,
    hasLink: Boolean(row.hasLink),
    mentionsMe: Boolean(row.mentionsMe)
  };
}

function readGroups(range: DashboardRange, query: string, scope: FeedScope) {
  const args: unknown[] = [range.since, range.until];
  const parts = ['date(m.sent_at) BETWEEN ? AND ?'];
  appendScope(parts, args, scope);
  if (query) {
    parts.push('(m.content LIKE ? OR m.group_name LIKE ? OR m.sender LIKE ?)');
    const like = `%${query}%`;
    args.push(like, like, like);
  }

  const rows = db.prepare(`
    SELECT m.group_name AS name, COUNT(*) AS count, MAX(m.sent_at) AS lastTime
    FROM messages m
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE ${parts.join(' AND ')}
    GROUP BY m.group_name
    ORDER BY count DESC, lastTime DESC
    LIMIT 10
  `).all(...args) as Array<{ name: string; count: number; lastTime: string }>;

  return rows.map((row) => ({
    name: row.name,
    count: row.count,
    lastTime: formatRelative(row.lastTime)
  }));
}

function readTypes(range: DashboardRange, scope: FeedScope) {
  const parts = ['date(m.sent_at) BETWEEN ? AND ?'];
  const args: unknown[] = [range.since, range.until];
  appendScope(parts, args, scope);
  return db.prepare(`
    SELECT m.type AS name, COUNT(*) AS count
    FROM messages m
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE ${parts.join(' AND ')}
    GROUP BY m.type
    ORDER BY count DESC
    LIMIT 8
  `).all(...args) as Array<{ name: string; count: number }>;
}

function normalizeKind(value?: string): FeedKind {
  if (value === 'signals' || value === 'actions' || value === 'mentions' || value === 'links') return value;
  return 'all';
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}

function count(sql: string, args: unknown[] = []) {
  return ((db.prepare(sql).get(...args) as CountRow | undefined)?.count ?? 0);
}

function countScoped(range: DashboardRange, extra: string, scope: FeedScope) {
  const parts = ['date(m.sent_at) BETWEEN ? AND ?', extra];
  const args: unknown[] = [range.since, range.until];
  appendScope(parts, args, scope);
  return count(`
    SELECT COUNT(*) AS count
    FROM messages m
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE ${parts.join(' AND ')}
  `, args);
}

function normalizeScope(scope = 'all', value = ''): FeedScope {
  if (scope === 'favorite') return { type: 'favorite', value: '', label: '收藏群' };
  if (scope === 'ungrouped') return { type: 'ungrouped', value: '未分组', label: '未分组' };
  if (scope === 'collection' && value) return { type: 'collection', value, label: value };
  if (scope === 'group' && value) return { type: 'group', value, label: value };
  return { type: 'all', value: '', label: '所有群' };
}

function appendScope(parts: string[], args: unknown[], scope: FeedScope) {
  parts.push("g.chat_type = 'group'");
  if (scope.type === 'favorite') parts.push('COALESCE(g.favorite, 0) = 1');
  if (scope.type === 'ungrouped') parts.push("COALESCE(g.collection, '未分组') = '未分组'");
  if (scope.type === 'collection') {
    parts.push('g.collection = ?');
    args.push(scope.value);
  }
  if (scope.type === 'group') {
    parts.push('m.group_name = ?');
    args.push(scope.value);
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function compactTitle(text: string) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '空内容消息';
  return oneLine.length > 46 ? `${oneLine.slice(0, 46)}...` : oneLine;
}

function parseTags(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
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

function formatRelative(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  return formatDateTime(value);
}
