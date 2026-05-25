import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { backfillContactProfilesFromExistingData, refreshContactProfilesFromWxCache } from './contacts.js';
import { ensureSchema } from './db.js';
import { getDashboard } from './dashboard.js';
import { getFeed } from './feed.js';
import { refreshGroupNamesFromWxCache } from './groupNames.js';
import { applyAutoCollections, getGroupCollections, getGroupDetail, getGroups, getPrivateChatDetail, getPrivateChats, toggleFavorite } from './groups.js';
import { getLinks, getRadar } from './insights.js';
import { getMediaLibrary } from './mediaLibrary.js';
import { resolveMessageFile, resolveMessageImage, resolveMessageVideo, resolveMessageVideoThumbnail } from './media.js';
import { resolveMessageEmoji } from './emoji.js';
import { configureMomentMediaResolver, resolveMomentMedia } from './momentMedia.js';
import { getMoments, getMomentNotifications, searchMoments } from './moments.js';
import { getSyncStatus, performIncrementalSync, startAutoIncrementalSync, startFullSync, type SyncScope } from './sync.js';
import { checkPreflight } from './wx.js';

ensureSchema();
refreshContactProfilesFromWxCache();
backfillContactProfilesFromExistingData();
refreshGroupNamesFromWxCache();
applyAutoCollections();
startAutoIncrementalSync();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/_wechat-wasm', express.static(path.resolve(process.cwd(), 'server', 'wechat_files')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'weicui' });
});

app.get('/api/preflight', async (_req, res) => {
  res.json(await checkPreflight());
});

app.get('/api/dashboard', async (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  const until = typeof req.query.until === 'string' ? req.query.until : undefined;
  const preflight = await checkPreflight();
  res.json(getDashboard(preflight, getSyncStatus(), since, until));
});

app.get('/api/feed', (req, res) => {
  res.json(getFeed({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
    offset: typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined,
    scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
    scopeValue: typeof req.query.scopeValue === 'string' ? req.query.scopeValue : undefined
  }));
});

app.get('/api/groups', (req, res) => {
  res.json(getGroups({
    scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
    collection: typeof req.query.collection === 'string' ? req.query.collection : undefined,
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined
  }));
});

app.get('/api/group-collections', (_req, res) => {
  res.json({ collections: getGroupCollections() });
});

app.post('/api/groups/resolve-names', (_req, res) => {
  const result = refreshGroupNamesFromWxCache();
  applyAutoCollections();
  res.json(result);
});

app.get('/api/messages/:id/image', async (req, res) => {
  const image = await resolveMessageImage(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'image_not_found' });
    return;
  }
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(image.path);
});

app.get('/api/messages/:id/video', async (req, res) => {
  const video = await resolveMessageVideo(req.params.id);
  if (!video) {
    const thumb = await resolveMessageVideoThumbnail(req.params.id);
    res.status(404).json({ error: 'video_not_cached', thumbnailAvailable: Boolean(thumb) });
    return;
  }
  res.setHeader('Content-Type', video.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(video.path);
});

app.get('/api/messages/:id/video/thumb', async (req, res) => {
  const thumb = await resolveMessageVideoThumbnail(req.params.id);
  if (!thumb) {
    res.status(404).json({ error: 'video_thumbnail_not_found' });
    return;
  }
  res.setHeader('Content-Type', thumb.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(thumb.path);
});

app.get('/api/messages/:id/emoji', async (req, res) => {
  const emoji = await resolveMessageEmoji(req.params.id);
  if (!emoji) {
    res.status(404).json({ error: 'emoji_not_found' });
    return;
  }
  res.setHeader('Content-Type', emoji.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(emoji.fileName)}"`);
  res.sendFile(emoji.path);
});

app.get('/api/messages/:id/file', async (req, res) => {
  const file = await resolveMessageFile(req.params.id);
  if (!file) {
    res.status(404).json({ error: 'file_not_found' });
    return;
  }
  res.setHeader('Content-Type', file.mime);
  res.download(file.path, file.fileName);
});

app.get('/api/groups/:id', (req, res) => {
  const detail = getGroupDetail(req.params.id, typeof req.query.tab === 'string' ? req.query.tab : undefined);
  if (!detail) {
    res.status(404).json({ error: 'group_not_found' });
    return;
  }
  res.json(detail);
});

app.get('/api/private-chats', (req, res) => {
  res.json(getPrivateChats({
    query: typeof req.query.q === 'string' ? req.query.q : undefined
  }));
});

app.get('/api/private-chats/:id', (req, res) => {
  const detail = getPrivateChatDetail(req.params.id, typeof req.query.tab === 'string' ? req.query.tab : undefined);
  if (!detail) {
    res.status(404).json({ error: 'private_chat_not_found' });
    return;
  }
  res.json(detail);
});

app.post('/api/groups/:id/favorite', (req, res) => {
  const group = toggleFavorite(req.params.id, typeof req.body?.favorite === 'boolean' ? req.body.favorite : undefined);
  if (!group) {
    res.status(404).json({ error: 'group_not_found' });
    return;
  }
  res.json(group);
});

app.get('/api/radar', (req, res) => {
  res.json(getRadar({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
    scopeValue: typeof req.query.scopeValue === 'string' ? req.query.scopeValue : undefined
  }));
});

app.get('/api/links', (req, res) => {
  res.json(getLinks({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
    scopeValue: typeof req.query.scopeValue === 'string' ? req.query.scopeValue : undefined
  }));
});

app.get('/api/moments', (req, res) => {
  res.json(getMoments({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    author: typeof req.query.author === 'string' ? req.query.author : undefined
  }));
});

app.get('/api/moments/search', (req, res) => {
  res.json(searchMoments({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    author: typeof req.query.author === 'string' ? req.query.author : undefined
  }));
});

app.get('/api/moments/notifications', (req, res) => {
  res.json(getMomentNotifications({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined
  }));
});

app.get('/api/moments/:id/media/:index', async (req, res) => {
  const variant = req.query.variant === 'full' ? 'full' : 'thumb';
  const media = await resolveMomentMedia(req.params.id, Number(req.params.index), variant);
  if (!media) {
    res.status(404).json({ error: 'moment_media_not_found' });
    return;
  }
  res.setHeader('Content-Type', media.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (variant === 'full') {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(media.fileName)}"`);
  }
  res.sendFile(media.path);
});

app.get('/api/media', (req, res) => {
  res.json(getMediaLibrary({
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    source: typeof req.query.source === 'string' ? req.query.source : undefined,
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
    chatId: typeof req.query.chatId === 'string' ? req.query.chatId : undefined,
    sender: typeof req.query.sender === 'string' ? req.query.sender : undefined,
    query: typeof req.query.q === 'string' ? req.query.q : undefined
  }));
});

app.get('/api/sync/status', (_req, res) => {
  res.json(getSyncStatus());
});

app.post('/api/sync/full', async (req, res) => {
  const days = Number(req.body?.days || 30);
  const since = typeof req.body?.since === 'string' ? req.body.since : undefined;
  const until = typeof req.body?.until === 'string' ? req.body.until : undefined;
  const scope = typeof req.body?.scope === 'string' ? req.body.scope as SyncScope : 'group';
  res.status(202).json(await startFullSync(days, since, until, scope));
});

app.post('/api/sync/incremental', async (req, res) => {
  const scope = typeof req.body?.scope === 'string' ? req.body.scope as SyncScope : 'group';
  res.status(202).json(await performIncrementalSync(scope));
});

const port = Number(process.env.PORT || 5174);
configureMomentMediaResolver(`http://127.0.0.1:${port}/_wechat-wasm/`);
app.listen(port, '127.0.0.1', () => {
  console.log(`wxlocal API listening at http://127.0.0.1:${port}`);
});
