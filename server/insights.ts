import { getContactProfile } from './contacts.js';
import { db } from './db.js';
import type { DashboardRange } from './types.js';

type Scope = {
  type: 'all' | 'favorite' | 'ungrouped' | 'collection' | 'group';
  value: string;
  label: string;
};

type MessageRow = {
  id: string;
  groupName: string;
  sender: string;
  sentAt: string;
  content: string;
  score: number | null;
};

const topicRules = [
  { name: 'AI Agent', patterns: [/agent/i, /智能体/, /代理/] },
  { name: '模型发布', patterns: [/模型/, /LLM/i, /GPT/i, /Claude/i, /Gemini/i, /RWKV/i] },
  { name: '工具产品', patterns: [/工具/, /产品/, /插件/, /平台/, /API/i, /软件/] },
  { name: '开源项目', patterns: [/开源/, /github/i, /repo/i, /仓库/] },
  { name: '商业合作', patterns: [/合作/, /报价/, /购买/, /团购/, /商业/, /客户/] },
  { name: '活动报名', patterns: [/报名/, /活动/, /会议/, /直播/, /分享/] },
  { name: '内容创作', patterns: [/内容/, /视频/, /公众号/, /文章/, /创作/] },
  { name: '研究学习', patterns: [/论文/, /研究/, /学习/, /课程/, /知识库/] }
];

export function getRadar(params: InsightParams) {
  const range = normalizeRange(params.since, params.until);
  const scope = normalizeScope(params.scope, params.scopeValue);
  const rows = readMessages(range, scope, 3000);
  const topics = topicRules.map((rule) => {
    const matched = rows.filter((row) => rule.patterns.some((pattern) => pattern.test(row.content)));
    const examples = matched.slice(0, 4).map(toExample);
    return {
      name: rule.name,
      count: matched.length,
      score: matched.reduce((sum, row) => sum + Math.max(1, Number(row.score || 0)), 0),
      groups: new Set(matched.map((row) => row.groupName)).size,
      examples
    };
  }).filter((topic) => topic.count > 0).sort((a, b) => b.score - a.score || b.count - a.count);

  return {
    range,
    scope,
    totalMessages: rows.length,
    topics: topics.slice(0, 12),
    keywords: extractKeywords(rows).slice(0, 24)
  };
}

export function getLinks(params: InsightParams) {
  const range = normalizeRange(params.since, params.until);
  const scope = normalizeScope(params.scope, params.scopeValue);
  const where = buildWhere(range, scope, 'm.has_link = 1');
  const rows = db.prepare(`
    SELECT
      m.id,
      m.group_name AS groupName,
      m.sender,
      m.sent_at AS sentAt,
      m.content,
      COALESCE(s.score, 0) AS score
    FROM messages m
    LEFT JOIN groups g ON g.id = m.group_id
    LEFT JOIN signals s ON s.message_id = m.id
    WHERE ${where.sql}
    ORDER BY m.sent_at DESC, COALESCE(s.score, 0) DESC
    LIMIT 600
  `).all(...where.args) as MessageRow[];

  const items = rows.flatMap((row) => extractUrls(row.content).map((url) => ({
    id: `${row.id}:${url}`,
    rank: 0,
    url,
    domain: safeDomain(url),
    title: compactTitle(row.content),
    groupName: row.groupName,
    sender: getContactProfile(row.sender, row.sender).displayName,
    time: formatDateTime(row.sentAt),
    tags: ['链接情报', safeDomain(url)],
    kind: 'signal',
    score: Number(row.score || 0),
    content: row.content
  }))).map((item, index) => ({ ...item, rank: index + 1 }));

  const domainMap = new Map<string, { domain: string; count: number; score: number; lastTime: string }>();
  for (const item of items) {
    const current = domainMap.get(item.domain) || { domain: item.domain, count: 0, score: 0, lastTime: item.time };
    current.count += 1;
    current.score += Math.max(1, item.score);
    current.lastTime = item.time;
    domainMap.set(item.domain, current);
  }

  return {
    range,
    scope,
    totalLinks: items.length,
    domains: [...domainMap.values()].sort((a, b) => b.count - a.count || b.score - a.score).slice(0, 12),
    items: items.slice(0, 120)
  };
}

type InsightParams = {
  since?: string;
  until?: string;
  scope?: string;
  scopeValue?: string;
};

function readMessages(range: DashboardRange, scope: Scope, limit: number) {
  const where = buildWhere(range, scope, '1 = 1');
  return db.prepare(`
    SELECT
      m.id,
      m.group_name AS groupName,
      m.sender,
      m.sent_at AS sentAt,
      m.content,
      COALESCE(s.score, 0) AS score
    FROM messages m
    LEFT JOIN groups g ON g.id = m.group_id
    LEFT JOIN signals s ON s.message_id = m.id
    WHERE ${where.sql}
    ORDER BY m.sent_at DESC
    LIMIT ?
  `).all(...where.args, limit) as MessageRow[];
}

function buildWhere(range: DashboardRange, scope: Scope, extra: string) {
  const parts = ['date(m.sent_at) BETWEEN ? AND ?', extra, "g.chat_type = 'group'"];
  const args: unknown[] = [range.since, range.until];
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
  return { sql: parts.join(' AND '), args };
}

function normalizeScope(scope = 'all', value = ''): Scope {
  if (scope === 'favorite') return { type: 'favorite', value: '', label: '收藏群' };
  if (scope === 'ungrouped') return { type: 'ungrouped', value: '未分组', label: '未分组' };
  if (scope === 'collection' && value) return { type: 'collection', value, label: value };
  if (scope === 'group' && value) return { type: 'group', value, label: value };
  return { type: 'all', value: '', label: '所有群' };
}

function extractKeywords(rows: MessageRow[]) {
  const counts = new Map<string, number>();
  const stopWords = new Set(['这个', '一个', '可以', '我们', '你们', '他们', '没有', '不是', '就是', '还是', '什么', '怎么', '需要', '一下']);
  for (const row of rows) {
    const matches = row.content.match(/[A-Za-z][A-Za-z0-9+._-]{2,}|[\u4e00-\u9fa5]{2,6}/g) || [];
    for (const match of matches) {
      if (stopWords.has(match) || /^\d+$/.test(match)) continue;
      counts.set(match, (counts.get(match) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function extractUrls(text: string) {
  const raw = text.match(/https?:\/\/[^\s)\]）]+|www\.[^\s)\]）]+/gi) || [];
  return [...new Set(raw.map((url) => (url.startsWith('www.') ? `https://${url}` : url)))];
}

function safeDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function toExample(row: MessageRow) {
  return {
    id: row.id,
    rank: 0,
    title: compactTitle(row.content),
    groupName: row.groupName,
    sender: getContactProfile(row.sender, row.sender).displayName,
    time: formatDateTime(row.sentAt),
    tags: ['话题雷达'],
    kind: 'signal',
    score: Number(row.score || 0),
    content: row.content
  };
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}

function compactTitle(text: string) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '空内容消息';
  return oneLine.length > 54 ? `${oneLine.slice(0, 54)}...` : oneLine;
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
