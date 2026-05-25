import { getContactProfile } from './contacts.js';
import { db } from './db.js';
import { toMessage } from './groups.js';

type MediaSource = 'all' | 'group' | 'private' | 'moments';
type MediaType = 'all' | 'image' | 'video';

type MediaParams = {
  since?: string;
  until?: string;
  source?: string;
  type?: string;
  chatId?: string;
  sender?: string;
  query?: string;
};

type MediaItem = ReturnType<typeof toMessage> & {
  chatId: string;
  chatName: string;
  chatType: 'group' | 'private' | 'moments';
  sourceLabel: string;
  sentAtRaw: string;
};

type MomentMedia = Record<string, unknown>;

export function getMediaLibrary(params: MediaParams) {
  const range = normalizeRange(params.since, params.until);
  const source = normalizeSource(params.source);
  const type = normalizeType(params.type);
  const items = [
    ...getChatMediaItems(range, { ...params, source, type }),
    ...getMomentMediaItems(range, { ...params, source, type })
  ].sort((a, b) => new Date(b.sentAtRaw).getTime() - new Date(a.sentAtRaw).getTime());
  const limited = items.slice(0, 400).map(({ sentAtRaw: _sentAtRaw, ...item }) => item);

  return {
    range,
    source,
    type,
    total: items.length,
    metrics: buildMetrics(items),
    items: limited
  };
}

function getChatMediaItems(range: { since: string; until: string }, params: MediaParams & { source: MediaSource; type: MediaType }): MediaItem[] {
  if (params.source === 'moments') return [];
  const where = buildChatWhere(range, params);
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
    LIMIT 800
  `).all(...where.args) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...toMessage(row),
    chatId: String(row.groupId),
    chatName: String(row.chatName || ''),
    chatType: String(row.chatType || 'group') === 'private' ? 'private' : 'group',
    sourceLabel: String(row.chatType) === 'private' ? '私萃' : '群萃',
    sentAtRaw: String(row.sentAt || '')
  }));
}

function getMomentMediaItems(range: { since: string; until: string }, params: MediaParams & { source: MediaSource; type: MediaType }): MediaItem[] {
  if (params.source === 'group' || params.source === 'private') return [];
  if (params.chatId && !params.chatId.startsWith('moment:')) return [];

  const rows = db.prepare(`
    SELECT id, author, author_username AS authorUsername, content, sent_at AS sentAt, media_json AS mediaJson
    FROM moments
    WHERE date(sent_at) BETWEEN ? AND ?
    ORDER BY datetime(sent_at) DESC
    LIMIT 1000
  `).all(range.since, range.until) as Array<Record<string, unknown>>;

  const query = params.query?.trim().toLowerCase() || '';
  const senderQuery = params.sender?.trim().toLowerCase() || '';
  const items: MediaItem[] = [];

  for (const row of rows) {
    const media = parseMediaJson(String(row.mediaJson || '[]'));
    const authorKey = String(row.authorUsername || row.author || '');
    const profile = getContactProfile(authorKey, String(row.author || '朋友圈作者'));
    const authorName = profile.displayName || String(row.author || '朋友圈作者');
    const content = String(row.content || '');
    const haystack = `${authorName} ${profile.remarkName} ${profile.nickname} ${authorKey} ${content}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    if (senderQuery && !haystack.includes(senderQuery)) continue;

    media.forEach((item, index) => {
      const isVideo = isMomentVideo(item);
      if (params.type === 'image' && isVideo) return;
      if (params.type === 'video' && !isVideo) return;
      const momentId = String(row.id);
      const previewUrl = `/api/moments/${encodeURIComponent(momentId)}/media/${index}?variant=thumb`;
      const fullUrl = `/api/moments/${encodeURIComponent(momentId)}/media/${index}?variant=full`;
      const mediaType = isVideo ? '视频' : '图片';
      const title = content ? compactTitle(content) : `朋友圈${mediaType}`;
      items.push({
        id: `moment:${momentId}:${index}`,
        sender: authorName,
        senderRaw: authorKey,
        senderProfile: profile,
        time: formatDateTime(String(row.sentAt || '')),
        type: mediaType,
        content,
        title,
        mentionsMe: false,
        hasLink: false,
        image: !isVideo ? { localId: index + 1, previewUrl, fullUrl } : undefined,
        video: isVideo ? { localId: index + 1, previewUrl, fullUrl } : undefined,
        chatId: `moment:${momentId}`,
        chatName: '朋友圈',
        chatType: 'moments',
        sourceLabel: '圈萃',
        sentAtRaw: String(row.sentAt || '')
      } as MediaItem);
    });
  }

  return items;
}

function buildChatWhere(range: { since: string; until: string }, params: MediaParams & { source: MediaSource; type: MediaType }) {
  const parts = ['date(m.sent_at) BETWEEN ? AND ?'];
  const args: unknown[] = [range.since, range.until];

  if (params.source === 'group' || params.source === 'private') {
    parts.push('g.chat_type = ?');
    args.push(params.source);
  } else {
    parts.push("g.chat_type IN ('group', 'private')");
  }

  if (params.type === 'image') parts.push("(m.type LIKE '%图片%' OR m.content LIKE '%[图片]%')");
  if (params.type === 'video') parts.push("(m.type LIKE '%视频%' OR m.content LIKE '%[视频]%')");
  if (params.type === 'all') parts.push("((m.type LIKE '%图片%' OR m.content LIKE '%[图片]%') OR (m.type LIKE '%视频%' OR m.content LIKE '%[视频]%'))");

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

function buildMetrics(items: MediaItem[]) {
  const chats = new Set(items.map((item) => `${item.chatType}:${item.chatId}`));
  const senders = new Set(items.map((item) => item.senderRaw || item.sender));
  return {
    images: items.filter((item) => Boolean(item.image)).length,
    videos: items.filter((item) => Boolean(item.video)).length,
    chats: chats.size,
    senders: senders.size
  };
}

function normalizeSource(source?: string): MediaSource {
  return source === 'group' || source === 'private' || source === 'moments' || source === 'all' ? source : 'all';
}

function normalizeType(type?: string): MediaType {
  return type === 'image' || type === 'video' || type === 'all' ? type : 'all';
}

function normalizeRange(since?: string, until?: string) {
  const end = until || new Date().toISOString().slice(0, 10);
  const start = since || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: start, until: end };
}

function parseMediaJson(value: string): MomentMedia[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === 'object') as MomentMedia[];
    return parsed && typeof parsed === 'object' ? [parsed as MomentMedia] : [];
  } catch {
    return [];
  }
}

function isMomentVideo(media: MomentMedia) {
  const type = String(media.type || '').toLowerCase();
  const url = String(media.url || media.thumb || '');
  if (Number(media.video_duration || 0) > 0) return true;
  if (['video', '4', '6', '15'].includes(type)) return true;
  return /snsvideodownload|video|\.mp4/i.test(url);
}

function compactTitle(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 64 ? `${normalized.slice(0, 64)}...` : normalized || '朋友圈媒体';
}

function formatDateTime(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
