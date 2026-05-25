import { getContactProfile, getMessageSenderProfile } from './contacts.js';
import { db } from './db.js';

export type GroupScope = 'all' | 'favorite' | 'ungrouped' | 'collection' | 'active' | 'silent';
export type GroupTab = 'members' | 'messages' | 'files' | 'links' | 'videos' | 'images';

type GroupRow = {
  id: string;
  name: string;
  collection: string;
  favorite: number;
  member_count: number;
  last_message_at: string | null;
  message_count: number;
  link_count: number;
  image_count: number;
  video_count: number;
  file_count: number;
  signal_count: number;
  sample: string | null;
  last_message_id?: string | null;
  last_message_sender?: string | null;
  last_message_sent_at?: string | null;
  last_message_type?: string | null;
  last_message_content?: string | null;
  last_message_mentions_me?: number | null;
  last_message_has_link?: number | null;
  last_message_raw_json?: string | null;
};

export function applyAutoCollections() {
  const groups = db.prepare(`
    SELECT
      g.id,
      g.name,
      COALESCE(group_concat(substr(m.content, 1, 120), ' '), '') AS sample
    FROM groups g
    LEFT JOIN (
      SELECT group_id, content, sent_at
      FROM messages
      ORDER BY sent_at DESC
      LIMIT 30000
    ) m ON m.group_id = g.id
    WHERE g.chat_type = 'group'
    GROUP BY g.id, g.name
  `).all() as Array<{ id: string; name: string; sample: string }>;

  const update = db.prepare('UPDATE groups SET collection = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const group of groups) {
      update.run(inferCollection(`${group.name} ${group.sample}`), group.id);
    }
  });
  tx();
}

export function getGroupCollections() {
  const rows = db.prepare(`
    SELECT id, name, collection, favorite, last_message_at AS lastMessageAt
    FROM groups
    WHERE chat_type = 'group'
    ORDER BY
      CASE WHEN collection = '未分组' THEN 1 ELSE 0 END,
      collection ASC,
      datetime(last_message_at) DESC,
      name ASC
  `).all() as Array<Record<string, unknown>>;

  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = String(row.collection || '未分组');
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }

  return [...map.entries()].map(([name, groups]) => ({
    name,
    count: groups.length,
    groups: groups.map((group) => ({
      id: String(group.id),
      name: displayGroupName(String(group.name), String(group.id)),
      rawName: String(group.name),
      favorite: Boolean(group.favorite),
      lastMessageAt: formatDateTime(String(group.lastMessageAt || ''))
    }))
  }));
}

export function getGroups(params: { scope?: string; collection?: string; query?: string; since?: string; until?: string }) {
  const scope = normalizeScope(params.scope);
  const query = (params.query || '').trim();
  const range = normalizeRange(params.since, params.until);
  const where = buildGroupWhere(scope, params.collection || '', query, range);

  const rows = db.prepare(`
    SELECT
      g.id,
      g.name,
      g.collection,
      g.favorite,
      g.member_count,
      g.last_message_at,
      COUNT(m.id) AS message_count,
      SUM(CASE WHEN m.has_link = 1 OR m.raw_json LIKE '%"url"%' THEN 1 ELSE 0 END) AS link_count,
      SUM(CASE WHEN m.type LIKE '%图片%' THEN 1 ELSE 0 END) AS image_count,
      SUM(CASE WHEN m.type LIKE '%视频%' THEN 1 ELSE 0 END) AS video_count,
      SUM(CASE WHEN m.content LIKE '%[文件]%' OR m.type = '文件' THEN 1 ELSE 0 END) AS file_count,
      COUNT(s.id) AS signal_count,
      substr((
        SELECT content
        FROM messages mm
        WHERE mm.group_id = g.id AND mm.content <> ''
        ORDER BY datetime(mm.sent_at) DESC
        LIMIT 1
      ), 1, 120) AS sample,
      ${latestMessageSelect('g.id')}
    FROM groups g
    LEFT JOIN messages m ON m.group_id = g.id
    LEFT JOIN signals s ON s.message_id = m.id
    ${where.sql}
    GROUP BY g.id
    ORDER BY datetime(g.last_message_at) DESC, message_count DESC, g.name ASC
  `).all(...where.args) as GroupRow[];

  return {
    scope,
    collection: params.collection || '',
    query,
    range,
    total: rows.length,
    groups: rows.map((row) => toGroupListItem(row, 'group'))
  };
}

export function getPrivateChats(params: { query?: string }) {
  const query = (params.query || '').trim();
  const parts = [
    "g.chat_type = 'private'",
    "g.id NOT LIKE 'gh_%'",
    "g.id NOT LIKE '@%'",
    "g.id NOT IN ('qqmail', 'fmessage', 'filehelper', 'medianote', 'floatbottle', 'weixin', 'notifymessage', 'brandsessionholder', 'brandservicesessionholder', 'officialaccounts', 'newsapp', 'feedsapp', 'mphelper', 'masssendapp', 'voiceinputapp', 'lbsapp', 'shakeapp', 'cardpackage')"
  ];
  const args: unknown[] = [];
  if (query) {
    parts.push(`(
      g.name LIKE ? OR g.id LIKE ? OR EXISTS (
        SELECT 1 FROM contact_profiles cp
        WHERE cp.username = g.id
          AND (cp.display_name LIKE ? OR cp.remark_name LIKE ? OR cp.nickname LIKE ?)
      )
    )`);
    const like = `%${query}%`;
    args.push(like, like, like, like, like);
  }

  const rows = db.prepare(`
    SELECT
      g.id,
      g.name,
      g.collection,
      g.favorite,
      g.member_count,
      g.last_message_at,
      COUNT(m.id) AS message_count,
      SUM(CASE WHEN m.has_link = 1 OR m.raw_json LIKE '%"url"%' THEN 1 ELSE 0 END) AS link_count,
      SUM(CASE WHEN m.type LIKE '%图片%' THEN 1 ELSE 0 END) AS image_count,
      SUM(CASE WHEN m.type LIKE '%视频%' THEN 1 ELSE 0 END) AS video_count,
      SUM(CASE WHEN m.content LIKE '%[文件]%' OR m.type = '文件' THEN 1 ELSE 0 END) AS file_count,
      COUNT(s.id) AS signal_count,
      substr((
        SELECT content
        FROM messages mm
        WHERE mm.group_id = g.id AND mm.content <> ''
        ORDER BY datetime(mm.sent_at) DESC
        LIMIT 1
      ), 1, 120) AS sample,
      ${latestMessageSelect('g.id')}
    FROM groups g
    LEFT JOIN messages m ON m.group_id = g.id
    LEFT JOIN signals s ON s.message_id = m.id
    WHERE ${parts.join(' AND ')}
    GROUP BY g.id
    ORDER BY
      CASE WHEN COUNT(m.id) > 0 THEN 0 ELSE 1 END,
      datetime(g.last_message_at) DESC,
      message_count DESC,
      g.name ASC
    LIMIT 200
  `).all(...args) as GroupRow[];

  return {
    query,
    total: rows.length,
    chats: rows.map((row) => toGroupListItem(row, 'private'))
  };
}

export function toggleFavorite(groupId: string, favorite?: boolean) {
  const current = db.prepare('SELECT favorite FROM groups WHERE id = ?').get(groupId) as { favorite: number } | undefined;
  if (!current) return null;
  const next = typeof favorite === 'boolean' ? favorite : !current.favorite;
  db.prepare('UPDATE groups SET favorite = ? WHERE id = ?').run(next ? 1 : 0, groupId);
  return getGroupSummary(groupId);
}

export function getGroupDetail(groupId: string, tab: string = 'messages') {
  const group = getGroupSummary(groupId);
  if (!group) return null;
  const activeTab = normalizeTab(tab);

  return {
    group,
    metrics: getGroupMetrics(groupId),
    tabs: {
      active: activeTab,
      counts: getTabCounts(groupId)
    },
    members: activeTab === 'members' ? getMembers(groupId) : [],
    messages: activeTab === 'messages' ? getMessages(groupId, '1 = 1') : [],
    files: activeTab === 'files' ? getMessages(groupId, "(content LIKE '%[文件]%' OR type = '文件')") : [],
    links: activeTab === 'links' ? getLinks(groupId) : [],
    videos: activeTab === 'videos' ? getMessages(groupId, "type LIKE '%视频%'") : [],
    images: activeTab === 'images' ? getMessages(groupId, "type LIKE '%图片%'") : []
  };
}

export function getPrivateChatDetail(chatId: string, tab: string = 'messages') {
  const chat = getSessionSummary(chatId, 'private');
  if (!chat) return null;
  const activeTab = normalizeTab(tab);

  return {
    group: chat,
    metrics: getGroupMetrics(chatId),
    tabs: {
      active: activeTab,
      counts: getTabCounts(chatId)
    },
    members: [],
    messages: activeTab === 'messages' ? getMessages(chatId, '1 = 1') : [],
    files: activeTab === 'files' ? getMessages(chatId, "(content LIKE '%[文件]%' OR type = '文件')") : [],
    links: activeTab === 'links' ? getLinks(chatId) : [],
    videos: activeTab === 'videos' ? getMessages(chatId, "type LIKE '%视频%'") : [],
    images: activeTab === 'images' ? getMessages(chatId, "type LIKE '%图片%'") : []
  };
}

function getGroupSummary(groupId: string) {
  return getSessionSummary(groupId, 'group');
}

function getSessionSummary(groupId: string, chatType: 'group' | 'private') {
  const row = db.prepare(`
    SELECT
      g.id,
      g.name,
      g.collection,
      g.favorite,
      g.member_count,
      g.last_message_at,
      COUNT(m.id) AS message_count,
      SUM(CASE WHEN m.has_link = 1 OR m.raw_json LIKE '%"url"%' THEN 1 ELSE 0 END) AS link_count,
      SUM(CASE WHEN m.type LIKE '%图片%' THEN 1 ELSE 0 END) AS image_count,
      SUM(CASE WHEN m.type LIKE '%视频%' THEN 1 ELSE 0 END) AS video_count,
      SUM(CASE WHEN m.content LIKE '%[文件]%' OR m.type = '文件' THEN 1 ELSE 0 END) AS file_count,
      COUNT(s.id) AS signal_count,
      substr((
        SELECT content
        FROM messages mm
        WHERE mm.group_id = g.id AND mm.content <> ''
        ORDER BY datetime(mm.sent_at) DESC
        LIMIT 1
      ), 1, 120) AS sample,
      ${latestMessageSelect('g.id')}
    FROM groups g
    LEFT JOIN messages m ON m.group_id = g.id
    LEFT JOIN signals s ON s.message_id = m.id
    WHERE g.id = ? AND g.chat_type = ?
    GROUP BY g.id
  `).get(groupId, chatType) as GroupRow | undefined;
  return row ? toGroupListItem(row, chatType) : null;
}

function getGroupMetrics(groupId: string) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS messages,
      COUNT(DISTINCT sender) AS senders,
      SUM(CASE WHEN has_link = 1 OR raw_json LIKE '%"url"%' THEN 1 ELSE 0 END) AS links,
      SUM(CASE WHEN type LIKE '%图片%' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN type LIKE '%视频%' THEN 1 ELSE 0 END) AS videos,
      SUM(CASE WHEN content LIKE '%[文件]%' OR type = '文件' THEN 1 ELSE 0 END) AS files,
      SUM(CASE WHEN mentions_me = 1 THEN 1 ELSE 0 END) AS mentions,
      MAX(sent_at) AS lastMessageAt
    FROM messages
    WHERE group_id = ?
  `).get(groupId) as Record<string, unknown>;

  const signalCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM signals s JOIN messages m ON m.id = s.message_id
    WHERE m.group_id = ?
  `).get(groupId) as { count: number }).count;

  return {
    messages: Number(row.messages || 0),
    senders: Number(row.senders || 0),
    links: Number(row.links || 0),
    images: Number(row.images || 0),
    videos: Number(row.videos || 0),
    files: Number(row.files || 0),
    mentions: Number(row.mentions || 0),
    signals: signalCount,
    lastMessageAt: formatDateTime(String(row.lastMessageAt || ''))
  };
}

function getTabCounts(groupId: string) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS messages,
      SUM(CASE WHEN has_link = 1 OR raw_json LIKE '%"url"%' THEN 1 ELSE 0 END) AS links,
      SUM(CASE WHEN type LIKE '%图片%' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN type LIKE '%视频%' THEN 1 ELSE 0 END) AS videos,
      SUM(CASE WHEN content LIKE '%[文件]%' OR type = '文件' THEN 1 ELSE 0 END) AS files
    FROM messages
    WHERE group_id = ?
  `).get(groupId) as Record<string, unknown>;
  const members = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT name FROM members WHERE group_id = ?
      UNION
      SELECT sender AS name FROM messages WHERE group_id = ? AND sender <> ''
    )
  `).get(groupId, groupId) as { count: number }).count;
  return {
    members,
    messages: Number(row.messages || 0),
    files: Number(row.files || 0),
    links: Number(row.links || 0),
    videos: Number(row.videos || 0),
    images: Number(row.images || 0)
  };
}

function getMembers(groupId: string) {
  const members = db.prepare(`
    SELECT id, name, alias, 0 AS messageCount, NULL AS lastSeenAt
    FROM members
    WHERE group_id = ?
    ORDER BY name ASC
    LIMIT 200
  `).all(groupId) as Array<Record<string, unknown>>;
  if (members.length > 0) return members.map(toMember);

  return (db.prepare(`
    SELECT sender AS id, sender AS name, '' AS alias, COUNT(*) AS messageCount, MAX(sent_at) AS lastSeenAt
    FROM messages
    WHERE group_id = ? AND sender <> ''
    GROUP BY sender
    ORDER BY messageCount DESC, datetime(lastSeenAt) DESC
    LIMIT 200
  `).all(groupId) as Array<Record<string, unknown>>).map(toMember);
}

function getMessages(groupId: string, extraWhere: string) {
  return (db.prepare(`
    SELECT id, group_id AS groupId, sender, sent_at AS sentAt, type, content, mentions_me AS mentionsMe, has_link AS hasLink, raw_json AS rawJson
    FROM messages
    WHERE group_id = ? AND ${extraWhere}
    ORDER BY datetime(sent_at) DESC
    LIMIT 200
  `).all(groupId) as Array<Record<string, unknown>>).map(toMessage);
}

function getLinks(groupId: string) {
  return getMessages(groupId, `(has_link = 1 OR raw_json LIKE '%"url"%')`).flatMap((message) =>
    extractMessageUrls(message).map((url) => ({
      ...message,
      url,
      domain: safeDomain(url)
    }))
  );
}

function buildGroupWhere(scope: GroupScope, collection: string, query: string, range: { since: string; until: string }) {
  const parts: string[] = ["g.chat_type = 'group'"];
  const args: unknown[] = [];
  if (scope === 'favorite') parts.push('g.favorite = 1');
  if (scope === 'ungrouped') parts.push("g.collection = '未分组'");
  if (scope === 'active') {
    parts.push('EXISTS (SELECT 1 FROM messages active_m WHERE active_m.group_id = g.id AND date(active_m.sent_at) BETWEEN ? AND ?)');
    args.push(range.since, range.until);
  }
  if (scope === 'silent') {
    parts.push('NOT EXISTS (SELECT 1 FROM messages active_m WHERE active_m.group_id = g.id AND date(active_m.sent_at) BETWEEN ? AND ?)');
    args.push(range.since, range.until);
  }
  if (scope === 'collection' && collection) {
    parts.push('g.collection = ?');
    args.push(collection);
  }
  if (query) {
    parts.push('(g.name LIKE ? OR g.id LIKE ? OR g.collection LIKE ?)');
    const like = `%${query}%`;
    args.push(like, like, like);
  }
  return {
    sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    args
  };
}

function toGroupListItem(row: GroupRow, chatType: 'group' | 'private' = 'group') {
  const profile = chatType === 'private' ? getContactProfile(row.id, row.name) : undefined;
  return {
    id: row.id,
    name: profile?.displayName || displayGroupName(row.name, row.id),
    rawName: row.name,
    profile,
    collection: row.collection || '未分组',
    favorite: Boolean(row.favorite),
    memberCount: Number(row.member_count || 0),
    messageCount: Number(row.message_count || 0),
    linkCount: Number(row.link_count || 0),
    imageCount: Number(row.image_count || 0),
    videoCount: Number(row.video_count || 0),
    fileCount: Number(row.file_count || 0),
    signalCount: Number(row.signal_count || 0),
    lastMessageAt: formatDateTime(row.last_message_at || ''),
    sample: row.sample || '',
    lastMessage: toLatestMessage(row)
  };
}

function latestMessageSelect(groupIdExpression: string) {
  const base = `
    FROM messages mm
    WHERE mm.group_id = ${groupIdExpression}
    ORDER BY datetime(mm.sent_at) DESC
    LIMIT 1
  `;
  return `
      (SELECT id ${base}) AS last_message_id,
      (SELECT sender ${base}) AS last_message_sender,
      (SELECT sent_at ${base}) AS last_message_sent_at,
      (SELECT type ${base}) AS last_message_type,
      (SELECT content ${base}) AS last_message_content,
      (SELECT mentions_me ${base}) AS last_message_mentions_me,
      (SELECT has_link ${base}) AS last_message_has_link,
      (SELECT raw_json ${base}) AS last_message_raw_json
  `;
}

function toLatestMessage(row: GroupRow) {
  if (!row.last_message_id) return null;
  return toMessage({
    id: row.last_message_id,
    groupId: row.id,
    sender: row.last_message_sender || '',
    sentAt: row.last_message_sent_at || '',
    type: row.last_message_type || '',
    content: row.last_message_content || '',
    mentionsMe: row.last_message_mentions_me || 0,
    hasLink: row.last_message_has_link || 0,
    rawJson: row.last_message_raw_json || ''
  });
}

function toMember(row: Record<string, unknown>) {
  const rawName = String(row.name || '未知成员');
  const profile = getContactProfile(String(row.id || row.alias || rawName), rawName);
  return {
    name: profile.displayName,
    rawName,
    alias: String(row.alias || ''),
    profile,
    messageCount: Number(row.messageCount || 0),
    lastSeenAt: formatDateTime(String(row.lastSeenAt || ''))
  };
}

export function toMessage(row: Record<string, unknown>) {
  const content = String(row.content || '');
  const id = String(row.id);
  const type = String(row.type || '');
  const rawJson = String(row.rawJson || '');
  const raw = parseRawMessage(rawJson);
  const imageLocalId = extractMediaLocalId('image', type, content, rawJson, id);
  const videoLocalId = extractMediaLocalId('video', type, content, rawJson, id);
  const emojiLocalId = extractEmojiLocalId(type, content, rawJson, id);
  const link = extractLinkInfo(content, raw);
  const file = extractFileInfo(content, id);
  const rawSender = String(row.sender || '未知成员');
  const senderProfile = getMessageSenderProfile(rawSender, rawSender, {
    groupId: String(row.groupId || ''),
    messageId: id,
    sentAt: String(row.sentAt || ''),
    content,
    rawJson
  });
  return {
    id,
    sender: senderProfile.displayName,
    senderRaw: rawSender,
    senderProfile,
    time: formatDateTime(String(row.sentAt || '')),
    type: String(row.type || '文本'),
    content,
    title: compactTitle(content),
    mentionsMe: Boolean(row.mentionsMe),
    hasLink: Boolean(row.hasLink),
    link,
    file,
    image: imageLocalId ? {
      localId: imageLocalId,
      previewUrl: `/api/messages/${encodeURIComponent(id)}/image`,
      fullUrl: `/api/messages/${encodeURIComponent(id)}/image`
    } : undefined,
    video: videoLocalId ? {
      localId: videoLocalId,
      previewUrl: `/api/messages/${encodeURIComponent(id)}/video/thumb`,
      fullUrl: `/api/messages/${encodeURIComponent(id)}/video`
    } : undefined,
    emoji: emojiLocalId ? {
      localId: emojiLocalId,
      previewUrl: `/api/messages/${encodeURIComponent(id)}/emoji`,
      fullUrl: `/api/messages/${encodeURIComponent(id)}/emoji`
    } : undefined
  };
}

function normalizeScope(scope?: string): GroupScope {
  if (scope === 'favorite' || scope === 'ungrouped' || scope === 'collection' || scope === 'active' || scope === 'silent') return scope;
  return 'all';
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}

function normalizeTab(tab: string): GroupTab {
  if (tab === 'members' || tab === 'files' || tab === 'links' || tab === 'videos' || tab === 'images') return tab;
  return 'messages';
}

function inferCollection(text: string) {
  const normalized = text.toLowerCase();
  const scores = new Map<string, number>();
  const rules: Array<[string, RegExp, number]> = [
    ['AI / Agent', /ai|aigc|agent|智能体|openai|codex|gpt|claude|gemini|deepseek|qwen|rwkv|大模型|模型|llm|langchain|manus/i, 4],
    ['开发 / 编程', /github|代码|编程|开发|前端|后端|api|cursor|编辑器|软件|项目|测试|部署|rpc|webtransport/i, 3],
    ['设备 / 项目', /bms|wifi|蓝牙|ble|ota|固件|设备|通信|温度|电池|验证码|app|安卓|ios|小程序|传感器|模块/i, 4],
    ['内容 / 媒体', /视频|图片|小红书|公众号|文章|创作|剪辑|x\.com|youtube|音乐|做图|绘图/i, 3],
    ['商业 / 营销', /客户|购买|价格|报价|团购|淘宝|营销|商业|增长|合作|订单|发货|保证金/i, 3],
    ['研究 / 学习', /论文|研究|学术|学习|课程|知识库|毕业|考试|学校|老师|学生/i, 3],
    ['生活 / 本地', /宝宝|酒店|江景|家长|自行车|吃|门口|校门|生活|同事|招聘会|交通/i, 3]
  ];
  for (const [name, pattern, weight] of rules) {
    const matches = normalized.match(pattern);
    if (matches) scores.set(name, (scores.get(name) || 0) + weight);
  }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : '未分组';
}

function displayGroupName(name: string, id: string) {
  if (name && name !== '未命名群') return name;
  return name === '未命名群' ? `未命名群 · ${id.replace('@chatroom', '')}` : id;
}

function compactTitle(text: string) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '空内容';
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}...` : oneLine;
}

function parseRawMessage(rawJson: string) {
  try {
    return rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function extractLinkInfo(content: string, raw: Record<string, unknown>) {
  const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
  const url = rawUrl || extractUrls(content)[0] || '';
  if (!url) return undefined;
  return {
    url,
    domain: safeDomain(url),
    title: cleanTypedTitle(content, '链接') || url
  };
}

function extractFileInfo(content: string, id: string) {
  const marker = '[文件]';
  const index = content.lastIndexOf(marker);
  if (index < 0) return undefined;
  let line = content.slice(index + marker.length).split('\n')[0].trim();
  let meta = '';
  const metaStart = line.lastIndexOf(' (');
  if (metaStart > 0 && line.endsWith(')')) {
    const candidate = line.slice(metaStart + 2, -1);
    if (candidate.includes(',')) {
      meta = candidate;
      line = line.slice(0, metaStart).trim();
    }
  }
  const parts = meta.split(',').map((part) => part.trim()).filter(Boolean);
  const extension = parts[1] || line.split('.').pop() || 'file';
  return {
    name: line || '未命名文件',
    size: parts[0] || '',
    extension,
    downloadUrl: `/api/messages/${encodeURIComponent(id)}/file`
  };
}

function cleanTypedTitle(content: string, label: string) {
  const text = content
    .replace(new RegExp(`^\\[${label}\\]\\s*`), '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function extractMediaLocalId(kind: 'image' | 'video', type: string, content: string, rawJson: string, id: string) {
  const isMatch = kind === 'image'
    ? /图片|image/i.test(type) || /\[图片\]/.test(content)
    : /视频|video/i.test(type) || /\[视频\]/.test(content);
  if (!isMatch) return 0;
  try {
    const raw = rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
    const direct = raw.local_id ?? raw.localId ?? raw.id;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
  } catch {
    // fall back to content parsing below
  }
  const match = content.match(/local_id=(\d+)/i);
  if (match) return Number(match[1]);
  return /^\d+$/.test(id) ? Number(id) : 0;
}

function extractEmojiLocalId(type: string, content: string, rawJson: string, id: string) {
  const isMatch = /表情|emoji|emoticon/i.test(type) || /\[表情\]/.test(content);
  if (!isMatch) return 0;
  try {
    const raw = rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
    const direct = raw.local_id ?? raw.localId ?? raw.id;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
  } catch {
    // fall back to the message id below
  }
  const match = content.match(/local_id=(\d+)/i);
  if (match) return Number(match[1]);
  return /^\d+$/.test(id) ? Number(id) : 0;
}

function extractUrls(text: string) {
  const raw = text.match(/https?:\/\/[^\s)\]）]+|www\.[^\s)\]）]+/gi) || [];
  return [...new Set(raw.map((url) => (url.startsWith('www.') ? `https://${url}` : url)))];
}

function extractMessageUrls(message: { content: string; link?: { url: string } }) {
  return [...new Set([
    message.link?.url || '',
    ...extractUrls(message.content)
  ].filter(Boolean))];
}

function safeDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}
