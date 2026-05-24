import { getContactProfile } from './contacts.js';
import { db } from './db.js';
import type { CollectionItem, DashboardResponse, SignalItem, SourceItem, WxPreflight, SyncStatus } from './types.js';

type CountRow = { count: number };

export function getDashboard(preflight: WxPreflight, sync: SyncStatus, since?: string, until?: string): DashboardResponse {
  const range = normalizeRange(since, until);
  const messageCount = count(`
    SELECT COUNT(*) AS count
    FROM messages m JOIN groups g ON g.id = m.group_id
    WHERE g.chat_type = 'group' AND date(m.sent_at) BETWEEN ? AND ?
  `, [range.since, range.until]);
  const groupTotal = count("SELECT COUNT(*) AS count FROM groups WHERE chat_type = 'group'");
  const activeGroups = count(`
    SELECT COUNT(DISTINCT m.group_id) AS count
    FROM messages m JOIN groups g ON g.id = m.group_id
    WHERE g.chat_type = 'group' AND date(m.sent_at) BETWEEN ? AND ?
  `, [range.since, range.until]);
  const mentions = count(`
    SELECT COUNT(*) AS count
    FROM messages m JOIN groups g ON g.id = m.group_id
    WHERE g.chat_type = 'group' AND m.mentions_me = 1 AND date(m.sent_at) BETWEEN ? AND ?
  `, [range.since, range.until]);
  const silentGroups = Math.max(0, groupTotal - activeGroups);

  const topSignals = readSignals('signal', range.since, range.until, 8);
  const actions = readSignals('action', range.since, range.until, 5);
  const sources = readSources(8);
  const collections = readCollections();
  const preview = groupTotal === 0 && messageCount === 0;

  return {
    range,
    preflight,
    sync,
    metrics: [
      { label: '活跃群', value: formatNumber(activeGroups), hint: `共扫 ${formatNumber(groupTotal)} 个群`, tone: 'mint' },
      { label: '总消息', value: formatNumber(messageCount), hint: `${range.since} ~ ${range.until}`, tone: 'mint' },
      { label: '@ 我的', value: formatNumber(mentions), hint: '需要回复', tone: 'amber' },
      { label: '静默群', value: formatNumber(silentGroups), hint: '范围内无活动', tone: 'neutral' }
    ],
    brief: buildBrief({ messageCount, activeGroups, groupTotal, mentions, topSignals, actions, preview, preflight }),
    groups: {
      total: groupTotal,
      favorites: count("SELECT COUNT(*) AS count FROM groups WHERE chat_type = 'group' AND favorite = 1"),
      ungrouped: count("SELECT COUNT(*) AS count FROM groups WHERE chat_type = 'group' AND collection = '未分组'"),
      active: activeGroups,
      silent: silentGroups
    },
    collections: collections.length > 0 ? collections : defaultCollections(),
    topSignals,
    actions,
    sources,
    preview
  };
}

function readSignals(kind: 'signal' | 'action', since: string, until: string, limit: number): SignalItem[] {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.kind,
      s.score,
      s.title,
      s.tags,
      m.group_name AS groupName,
      m.sender,
      m.sent_at AS sentAt,
      m.content
    FROM signals s
    JOIN messages m ON m.id = s.message_id
    JOIN groups g ON g.id = m.group_id
    WHERE g.chat_type = 'group' AND s.kind = ? AND date(m.sent_at) BETWEEN ? AND ?
    ORDER BY s.score DESC, m.sent_at DESC
    LIMIT ?
  `).all(kind, since, until, limit) as Array<Record<string, unknown>>;

  return rows.map((row, index) => ({
    id: Number(row.id),
    rank: index + 1,
    title: String(row.title),
    groupName: String(row.groupName),
    sender: getContactProfile(String(row.sender), String(row.sender)).displayName,
    time: formatTime(String(row.sentAt)),
    tags: parseTags(String(row.tags)),
    score: Number(row.score),
    kind,
    content: String(row.content)
  }));
}

function readSources(limit: number): SourceItem[] {
  const rows = db.prepare(`
    SELECT sender, score, message_count, group_count
    FROM sources
    ORDER BY score DESC, group_count DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map((row, index) => ({
    rank: index + 1,
    name: getContactProfile(String(row.sender), String(row.sender)).displayName,
    subtitle: `${formatNumber(Number(row.message_count))} 条消息 · ${formatNumber(Number(row.group_count))} 群`,
    score: Number(row.score),
    groupCount: Number(row.group_count)
  }));
}

function readCollections(): CollectionItem[] {
  const colors = ['#ef5f5f', '#64d982', '#4db4d7', '#4b9cec', '#7067ff', '#e45ca7', '#a970ff', '#55c795', '#f0a83d', '#e7c649', '#8f6df2', '#f47e43'];
  const rows = db.prepare(`
    SELECT collection AS name, COUNT(*) AS count
    FROM groups
    WHERE chat_type = 'group'
    GROUP BY collection
    ORDER BY count DESC, name ASC
    LIMIT 12
  `).all() as Array<{ name: string; count: number }>;

  return rows.map((row, index) => ({
    name: row.name,
    count: row.count,
    color: colors[index % colors.length]
  }));
}

function defaultCollections(): CollectionItem[] {
  return [
    { name: 'AI 产品虫虫团', count: 0, color: '#ef5f5f' },
    { name: '乔木自营群', count: 0, color: '#64d982' },
    { name: 'WaytoAGI', count: 0, color: '#4db4d7' },
    { name: 'HowOneAI', count: 0, color: '#4b9cec' },
    { name: 'Vibe Coding', count: 0, color: '#7067ff' },
    { name: 'AIGC 内容创作', count: 0, color: '#e45ca7' },
    { name: 'AI 学术', count: 0, color: '#a970ff' },
    { name: 'AI 商业·营销', count: 0, color: '#55c795' }
  ];
}

function buildBrief(input: {
  messageCount: number;
  activeGroups: number;
  groupTotal: number;
  mentions: number;
  topSignals: SignalItem[];
  actions: SignalItem[];
  preview: boolean;
  preflight: WxPreflight;
}) {
  if (!input.preflight.ok) {
    return '消息服务尚未完成初始化或后台服务暂不可用。看板已就绪，完成本机初始化后点击“全量同步”即可生成本地群情报。';
  }
  if (input.preview) {
    return '当前 SQLite 还没有同步数据。点击“全量同步”后将拉取近 30 天微信群消息，并在本机生成关注项、行动项和情报源排名。';
  }

  const lead = input.topSignals[0]?.title || input.actions[0]?.title || '暂无高优先级线索';
  return `本期覆盖 ${formatNumber(input.groupTotal)} 个群，${formatNumber(input.activeGroups)} 个群有活动，共 ${formatNumber(input.messageCount)} 条消息，@ 我的 ${formatNumber(input.mentions)} 条。重点关注：${lead}`;
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}

function count(sql: string, args: unknown[] = []) {
  return ((db.prepare(sql).get(...args) as CountRow | undefined)?.count ?? 0);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 5);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function parseTags(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
