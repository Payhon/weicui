import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AtSign,
  Bell,
  CalendarDays,
  ChevronRight,
  CheckCircle2,
  Clock,
  Clipboard,
  Database,
  Filter,
  FileText,
  Folder,
  Gauge,
  Hash,
  Image as ImageIcon,
  Link2,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  Settings,
  Signal,
  Sparkles,
  Star,
  Target,
  UserRoundSearch,
  UsersRound,
  Video,
  X,
  Zap
} from 'lucide-react';
import './styles.css';

type Tone = 'mint' | 'amber' | 'neutral';

type Metric = {
  label: string;
  value: string;
  hint: string;
  tone?: Tone;
};

type Preflight = {
  ok: boolean;
  wxFound: boolean;
  configFound: boolean;
  daemonOk: boolean;
  sessionsOk: boolean;
  daemonMessage?: string;
  sessionsMessage?: string;
  instructions: string[];
};

type SyncStatus = {
  running: boolean;
  phase: string;
  current?: string;
  totalGroups?: number;
  processedGroups?: number;
  error?: string;
};

type SignalItem = {
  id: number | string;
  rank: number;
  title: string;
  groupName: string;
  sender: string;
  time: string;
  tags: string[];
  score: number;
  kind: 'message' | 'signal' | 'action';
  content: string;
};

type FeedKind = 'all' | 'signals' | 'actions' | 'mentions' | 'links';

type FeedItem = {
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

type FeedResponse = {
  range: { since: string; until: string };
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
  scope: Scope;
};

type Scope = {
  type: 'all' | 'favorite' | 'ungrouped' | 'collection' | 'group';
  value: string;
  label: string;
};

type GroupListScope = 'all' | 'favorite' | 'ungrouped' | 'collection';
type GroupTab = 'members' | 'messages' | 'files' | 'links' | 'videos' | 'images';

type ContactProfile = {
  username: string;
  displayName: string;
  remarkName: string;
  nickname: string;
  avatarUrl: string;
  initial: string;
  resolved: boolean;
  subtitle: string;
};

type GroupItem = {
  id: string;
  name: string;
  rawName: string;
  profile?: ContactProfile;
  collection: string;
  favorite: boolean;
  memberCount: number;
  messageCount: number;
  linkCount: number;
  imageCount: number;
  videoCount: number;
  fileCount: number;
  signalCount: number;
  lastMessageAt: string;
  sample: string;
};

type GroupListResponse = {
  scope: GroupListScope;
  collection: string;
  query: string;
  total: number;
  groups: GroupItem[];
};

type GroupCollection = {
  name: string;
  count: number;
  groups: Array<Pick<GroupItem, 'id' | 'name' | 'rawName' | 'favorite' | 'lastMessageAt'>>;
};

type GroupMember = {
  name: string;
  rawName?: string;
  alias: string;
  profile?: ContactProfile;
  messageCount: number;
  lastSeenAt: string;
};

type GroupMessage = {
  id: string;
  sender: string;
  senderRaw?: string;
  senderProfile?: ContactProfile;
  time: string;
  type: string;
  content: string;
  title: string;
  mentionsMe: boolean;
  hasLink: boolean;
  url?: string;
  domain?: string;
  link?: {
    url: string;
    domain: string;
    title: string;
  };
  file?: {
    name: string;
    size: string;
    extension: string;
    downloadUrl: string;
  };
  image?: {
    localId: number;
    previewUrl: string;
    fullUrl: string;
  };
  video?: {
    localId: number;
    previewUrl: string;
    fullUrl: string;
  };
};

type GroupDetail = {
  group: GroupItem;
  metrics: {
    messages: number;
    senders: number;
    links: number;
    images: number;
    videos: number;
    files: number;
    mentions: number;
    signals: number;
    lastMessageAt: string;
  };
  tabs: {
    active: GroupTab;
    counts: Record<GroupTab, number>;
  };
  members: GroupMember[];
  messages: GroupMessage[];
  files: GroupMessage[];
  links: GroupMessage[];
  videos: GroupMessage[];
  images: GroupMessage[];
};

type PrivateChatsResponse = {
  query: string;
  total: number;
  chats: GroupItem[];
};

type MomentItem = {
  id: string;
  author: string;
  authorName: string;
  authorRaw: string;
  authorUsername: string;
  authorProfile?: ContactProfile;
  content: string;
  time: string;
  absoluteTime: string;
  media: unknown[];
  mediaCount: number;
  location: string;
};

type MomentsResponse = {
  range: { since: string; until: string };
  query: string;
  author: string;
  total: number;
  metrics: {
    posts: number;
    authors: number;
    media: number;
    notifications: number;
  };
  authors: Array<{ name: string; username: string; profile?: ContactProfile; count: number; lastTime: string }>;
  items: MomentItem[];
};

type MediaItem = GroupMessage & {
  chatId: string;
  chatName: string;
  chatType: 'group' | 'private';
  sourceLabel: string;
};

type MediaResponse = {
  range: { since: string; until: string };
  source: 'group' | 'private' | 'all';
  type: 'image' | 'video' | 'all';
  total: number;
  metrics: {
    images: number;
    videos: number;
    chats: number;
    senders: number;
  };
  items: MediaItem[];
};

type RadarResponse = {
  scope: Scope;
  totalMessages: number;
  topics: Array<{
    name: string;
    count: number;
    score: number;
    groups: number;
    examples: Array<SignalItem>;
  }>;
  keywords: Array<{ name: string; count: number }>;
};

type LinksResponse = {
  scope: Scope;
  totalLinks: number;
  domains: Array<{ domain: string; count: number; score: number; lastTime: string }>;
  items: Array<SignalItem & { url: string; domain: string; absoluteTime?: string }>;
};

type SourceItem = {
  rank: number;
  name: string;
  subtitle: string;
  score: number;
  groupCount: number;
};

type CollectionItem = {
  name: string;
  count: number;
  color: string;
};

type Dashboard = {
  range: { since: string; until: string };
  preflight: Preflight;
  sync: SyncStatus;
  metrics: Metric[];
  brief: string;
  groups: {
    total: number;
    favorites: number;
    ungrouped: number;
    active: number;
    silent: number;
  };
  collections: CollectionItem[];
  topSignals: SignalItem[];
  actions: SignalItem[];
  sources: SourceItem[];
  preview: boolean;
};

type AppModule = 'group' | 'private' | 'moments' | 'media';
type View = 'dashboard' | 'feed' | 'radar' | 'links' | 'groups' | 'groupDetail' | 'privateList' | 'privateDetail' | 'moments' | 'media' | 'settings';
type RangePreset = '日' | '周' | '月' | '季' | '年' | '自定义';
type SyncCadence = '自动' | '时' | '日' | '周';
type MediaSource = 'all' | 'group' | 'private';
type MediaKind = 'all' | 'image' | 'video';

const periodOptions: RangePreset[] = ['日', '周', '月', '季', '年', '自定义'];
const syncCadenceOptions: SyncCadence[] = ['自动', '时', '日', '周'];
const syncCadenceMs: Record<SyncCadence, number> = {
  自动: 5 * 60 * 1000,
  时: 60 * 60 * 1000,
  日: 24 * 60 * 60 * 1000,
  周: 7 * 24 * 60 * 60 * 1000
};

const defaultRange = makePresetRange(todayDateOnly(), '月');

function App() {
  const [range, setRange] = useState(defaultRange);
  const [period, setPeriod] = useState<RangePreset>('月');
  const [syncCadence, setSyncCadence] = useState<SyncCadence>(readSyncCadence);
  const [module, setModule] = useState<AppModule>('group');
  const [view, setView] = useState<View>('dashboard');
  const [scope, setScope] = useState<Scope>({ type: 'all', value: '', label: '所有群' });
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [radar, setRadar] = useState<RadarResponse | null>(null);
  const [links, setLinks] = useState<LinksResponse | null>(null);
  const [groupList, setGroupList] = useState<GroupListResponse | null>(null);
  const [groupCollections, setGroupCollections] = useState<GroupCollection[]>([]);
  const [groupScope, setGroupScope] = useState<{ scope: GroupListScope; label: string; collection: string }>({ scope: 'all', label: '所有群', collection: '' });
  const [expandedCollections, setExpandedCollections] = useState<Record<string, boolean>>({});
  const [groupQuery, setGroupQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [groupTab, setGroupTab] = useState<GroupTab>('messages');
  const [privateChats, setPrivateChats] = useState<PrivateChatsResponse | null>(null);
  const [privateQuery, setPrivateQuery] = useState('');
  const [selectedPrivateId, setSelectedPrivateId] = useState('');
  const [privateDetail, setPrivateDetail] = useState<GroupDetail | null>(null);
  const [privateTab, setPrivateTab] = useState<GroupTab>('messages');
  const [moments, setMoments] = useState<MomentsResponse | null>(null);
  const [momentQuery, setMomentQuery] = useState('');
  const [momentAuthor, setMomentAuthor] = useState('');
  const [media, setMedia] = useState<MediaResponse | null>(null);
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaSource, setMediaSource] = useState<MediaSource>('all');
  const [mediaKind, setMediaKind] = useState<MediaKind>('all');
  const [feedKind, setFeedKind] = useState<FeedKind>('all');
  const [feedQuery, setFeedQuery] = useState('');
  const [selected, setSelected] = useState<SignalItem | null>(null);
  const [previewImage, setPreviewImage] = useState<GroupMessage | null>(null);
  const [previewVideo, setPreviewVideo] = useState<GroupMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadDashboard(nextRange = range) {
    const params = new URLSearchParams(nextRange);
    const response = await fetch(`/api/dashboard?${params.toString()}`);
    const data = (await response.json()) as Dashboard;
    setDashboard(data);
    setLoading(false);
    setSyncing(data.sync.running);
  }

  function scopedParams(nextRange = range, nextScope = scope) {
    return {
      since: nextRange.since,
      until: nextRange.until,
      scope: nextScope.type,
      scopeValue: nextScope.value
    };
  }

  async function loadFeed(nextRange = range, nextKind = feedKind, nextQuery = feedQuery, nextScope = scope) {
    const params = new URLSearchParams({
      ...scopedParams(nextRange, nextScope),
      kind: nextKind,
      q: nextQuery,
      limit: '90'
    });
    const response = await fetch(`/api/feed?${params.toString()}`);
    setFeed((await response.json()) as FeedResponse);
  }

  async function loadRadar(nextRange = range, nextScope = scope) {
    const params = new URLSearchParams(scopedParams(nextRange, nextScope));
    const response = await fetch(`/api/radar?${params.toString()}`);
    setRadar((await response.json()) as RadarResponse);
  }

  async function loadLinks(nextRange = range, nextScope = scope) {
    const params = new URLSearchParams(scopedParams(nextRange, nextScope));
    const response = await fetch(`/api/links?${params.toString()}`);
    setLinks((await response.json()) as LinksResponse);
  }

  async function loadGroups(nextScope = groupScope, nextQuery = groupQuery) {
    const params = new URLSearchParams({
      scope: nextScope.scope,
      collection: nextScope.collection,
      q: nextQuery
    });
    const response = await fetch(`/api/groups?${params.toString()}`);
    setGroupList((await response.json()) as GroupListResponse);
  }

  async function loadGroupCollections() {
    const response = await fetch('/api/group-collections');
    const data = (await response.json()) as { collections: GroupCollection[] };
    setGroupCollections(data.collections);
  }

  async function loadGroupDetail(groupId = selectedGroupId, tab = groupTab) {
    if (!groupId) return;
    const params = new URLSearchParams({ tab });
    const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}?${params.toString()}`);
    setGroupDetail((await response.json()) as GroupDetail);
  }

  async function loadPrivateChats(nextQuery = privateQuery) {
    const params = new URLSearchParams({ q: nextQuery });
    const response = await fetch(`/api/private-chats?${params.toString()}`);
    setPrivateChats((await response.json()) as PrivateChatsResponse);
  }

  async function loadPrivateDetail(chatId = selectedPrivateId, tab = privateTab) {
    if (!chatId) return;
    const params = new URLSearchParams({ tab });
    const response = await fetch(`/api/private-chats/${encodeURIComponent(chatId)}?${params.toString()}`);
    setPrivateDetail((await response.json()) as GroupDetail);
  }

  async function loadMoments(nextRange = range, nextQuery = momentQuery, nextAuthor = momentAuthor) {
    const params = new URLSearchParams({
      since: nextRange.since,
      until: nextRange.until,
      q: nextQuery,
      author: nextAuthor
    });
    const response = await fetch(`/api/moments?${params.toString()}`);
    setMoments((await response.json()) as MomentsResponse);
  }

  async function loadMedia(nextRange = range, nextSource = mediaSource, nextKind = mediaKind, nextQuery = mediaQuery) {
    const params = new URLSearchParams({
      since: nextRange.since,
      until: nextRange.until,
      source: nextSource,
      type: nextKind,
      q: nextQuery
    });
    const response = await fetch(`/api/media?${params.toString()}`);
    setMedia((await response.json()) as MediaResponse);
  }

  useEffect(() => {
    void loadGroups();
    void loadGroupCollections();
  }, []);

  useEffect(() => {
    void loadDashboard(range);
    if (module === 'group') {
      void loadFeed(range);
      void loadRadar(range);
      void loadLinks(range);
    }
    if (module === 'moments') void loadMoments(range);
    if (module === 'media') void loadMedia(range);
    const timer = window.setInterval(() => void loadDashboard(range), 5000);
    return () => window.clearInterval(timer);
  }, [range.since, range.until, module]);

  useEffect(() => {
    window.localStorage.setItem('wxlocal.syncCadence', syncCadence);
    const timer = window.setInterval(() => void runIncrementalSync(true), syncCadenceMs[syncCadence]);
    return () => window.clearInterval(timer);
  }, [syncCadence, range.since, range.until, scope.type, scope.value]);

  useEffect(() => {
    void loadFeed(range, feedKind, feedQuery);
  }, [feedKind]);

  useEffect(() => {
    void loadFeed(range, feedKind, feedQuery, scope);
    void loadRadar(range, scope);
    void loadLinks(range, scope);
  }, [scope.type, scope.value]);

  useEffect(() => {
    if (module === 'private') void loadPrivateChats();
    if (module === 'moments') void loadMoments();
    if (module === 'media') void loadMedia();
  }, [module]);

  async function reloadCurrentViews(nextRange = range) {
    if (module === 'group') {
      await Promise.all([
        loadDashboard(nextRange),
        loadFeed(nextRange, feedKind, feedQuery, scope),
        loadRadar(nextRange, scope),
        loadLinks(nextRange, scope),
        loadGroups(groupScope, groupQuery),
        loadGroupCollections()
      ]);
      return;
    }
    if (module === 'private') {
      await Promise.all([loadDashboard(nextRange), loadPrivateChats(privateQuery)]);
      if (selectedPrivateId) await loadPrivateDetail(selectedPrivateId, privateTab);
      return;
    }
    if (module === 'moments') {
      await Promise.all([loadDashboard(nextRange), loadMoments(nextRange, momentQuery, momentAuthor)]);
      return;
    }
    await Promise.all([loadDashboard(nextRange), loadMedia(nextRange, mediaSource, mediaKind, mediaQuery)]);
  }

  async function startFullSync() {
    setSyncing(true);
    await fetch('/api/sync/full', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: range.since, until: range.until, days: rangeDays(range), scope: moduleToSyncScope(module) })
    });
    await reloadCurrentViews(range);
  }

  async function runIncrementalSync(silent = false) {
    if (!silent) setSyncing(true);
    await fetch('/api/sync/incremental', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: moduleToSyncScope(module) })
    });
    await reloadCurrentViews(range);
  }

  function openModule(nextModule: AppModule) {
    setModule(nextModule);
    if (nextModule === 'group') setView('dashboard');
    if (nextModule === 'private') setView('privateList');
    if (nextModule === 'moments') setView('moments');
    if (nextModule === 'media') setView('media');
  }

  function changePeriod(nextPeriod: RangePreset) {
    setPeriod(nextPeriod);
    if (nextPeriod !== '自定义') setRange(makePresetRange(range.until, nextPeriod));
  }

  function changeDate(value: string) {
    if (!value) return;
    setRange(period === '自定义' ? normalizeCustomRange(range.since, value) : makePresetRange(value, period));
  }

  function changeCustomSince(value: string) {
    if (!value) return;
    setPeriod('自定义');
    setRange(normalizeCustomRange(value, range.until));
  }

  function chooseScope(nextScope: Scope, nextView: View = 'feed') {
    setScope(nextScope);
    setView(nextView);
  }

  function openGroupList(nextScope: GroupListScope, label: string, collection = '') {
    const value = { scope: nextScope, label, collection };
    setGroupScope(value);
    setView('groups');
    void loadGroups(value, groupQuery);
  }

  function toggleCollection(collectionName: string) {
    setExpandedCollections((current) => ({
      ...current,
      [collectionName]: !current[collectionName]
    }));
    openGroupList('collection', collectionName, collectionName);
  }

  function openGroupDetail(groupId: string) {
    setSelectedGroupId(groupId);
    setGroupTab('messages');
    setModule('group');
    setView('groupDetail');
    void loadGroupDetail(groupId, 'messages');
  }

  function openPrivateDetail(chatId: string) {
    setSelectedPrivateId(chatId);
    setPrivateTab('messages');
    setModule('private');
    setView('privateDetail');
    void loadPrivateDetail(chatId, 'messages');
  }

  async function toggleGroupFavorite(groupId: string, favorite?: boolean) {
    await fetch(`/api/groups/${encodeURIComponent(groupId)}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite })
    });
    await Promise.all([loadDashboard(), loadGroups(), loadGroupCollections()]);
    if (selectedGroupId === groupId) await loadGroupDetail(groupId, groupTab);
  }

  async function copyBrief() {
    if (!dashboard) return;
    try {
      await navigator.clipboard.writeText(dashboard.brief);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = dashboard.brief;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const data = dashboard;
  const rangeLabel = useMemo(() => {
    if (!data) return `${range.since} ~ ${range.until}`;
    return `${data.range.since} ~ ${data.range.until} · 共 ${data.groups.total} 个群`;
  }, [data, range]);
  const activeTitle = module === 'private'
    ? (view === 'privateDetail' ? privateDetail?.group.name || '私聊详情' : '私萃 · 个人聊天分析')
    : module === 'moments'
      ? '圈萃 · 朋友圈整理'
      : module === 'media'
        ? '影萃 · 图片 / 视频检索'
        : view === 'feed' ? '群萃信号流 · Live' : view === 'radar' ? '话题雷达' : view === 'links' ? '链接情报' : view === 'groups' ? `${groupScope.label} · 群列表` : view === 'groupDetail' ? groupDetail?.group.name || '群聊详情' : view === 'settings' ? '本机配置' : '群萃 · 群聊消息整理';
  const scopedRangeLabel = module === 'private'
    ? (view === 'privateDetail' ? `${privateDetail?.group.lastMessageAt || ''} · ${privateDetail?.metrics.messages ?? 0} 条消息` : `近期私聊 · ${privateChats?.total ?? 0} 个会话`)
    : module === 'moments'
      ? `${range.since} ~ ${range.until} · ${moments?.total ?? 0} 条朋友圈`
      : module === 'media'
        ? `${range.since} ~ ${range.until} · ${media?.total ?? 0} 个媒体`
        : view === 'groups' ? `${groupScope.label} · ${groupList?.total ?? 0} 个群` : view === 'groupDetail' ? `${groupDetail?.group.collection || ''} · ${groupDetail?.group.lastMessageAt || ''}` : scope.type === 'all' ? rangeLabel : `${rangeLabel} · ${scope.label}`;

  return (
    <main className="page-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div>
            <div className="brand-kicker">WEICUI RADAR</div>
            <h1>微萃</h1>
            <p>语义微信消息提取</p>
          </div>
          <button className="icon-button" aria-label="设置" onClick={() => setView('settings')}>
            <Settings size={18} />
          </button>
        </div>

        <section className="side-section module-section">
          <div className="section-label">MODULES</div>
          <ModuleItem active={module === 'group'} icon={<UsersRound size={18} />} label="群萃" desc="群聊消息整理" onClick={() => openModule('group')} />
          <ModuleItem active={module === 'private'} icon={<MessageCircle size={18} />} label="私萃" desc="个人聊天分析" onClick={() => openModule('private')} />
          <ModuleItem active={module === 'moments'} icon={<Sparkles size={18} />} label="圈萃" desc="朋友圈整理" onClick={() => openModule('moments')} />
          <ModuleItem active={module === 'media'} icon={<ImageIcon size={18} />} label="影萃" desc="图片 / 视频检索" onClick={() => openModule('media')} />
        </section>

        {module === 'group' ? (
          <>
        <nav className="nav-list">
          <NavItem active={view === 'dashboard'} icon={<Gauge size={19} />} label="看板" badge="Brief" onClick={() => setView('dashboard')} />
          <NavItem active={view === 'feed'} icon={<Activity size={19} />} label="信号流" badge="Live" onClick={() => setView('feed')} />
          <NavItem active={view === 'radar'} icon={<Sparkles size={19} />} label="话题雷达" badge="Cross" onClick={() => setView('radar')} />
          <NavItem active={view === 'links'} icon={<Link2 size={19} />} label="链接情报" badge="Link" onClick={() => setView('links')} />
        </nav>

        <section className="side-section">
          <div className="section-label">GROUPS</div>
          <SideCounter active={view === 'groups' && groupScope.scope === 'all'} icon={<UsersRound size={18} />} label="所有群" value={data?.groups.total ?? 0} onClick={() => openGroupList('all', '所有群')} />
          <SideCounter active={view === 'groups' && groupScope.scope === 'favorite'} icon={<Star size={18} />} label="收藏" value={data?.groups.favorites ?? 0} onClick={() => openGroupList('favorite', '收藏群')} />
          <SideCounter active={view === 'groups' && groupScope.scope === 'ungrouped'} icon={<Folder size={18} />} label="未分组" value={data?.groups.ungrouped ?? 0} onClick={() => openGroupList('ungrouped', '未分组')} />
        </section>

        <section className="side-section collections">
          <div className="section-label">COLLECTIONS</div>
          {groupCollections.map((collection, index) => {
            const expanded = Boolean(expandedCollections[collection.name]);
            return (
              <div className={`collection-block ${expanded ? 'expanded' : ''}`} key={collection.name}>
                <button
                  className={`collection-row collection-heading ${view === 'groups' && groupScope.collection === collection.name ? 'active' : ''}`}
                  onClick={() => toggleCollection(collection.name)}
                  aria-expanded={expanded}
                >
                  <ChevronRight className="collection-caret" size={14} />
                  <span className="dot" style={{ background: collectionColor(index) }} />
                  <span className="collection-name">{collection.name}</span>
                  <span>{collection.count}</span>
                </button>
                {expanded ? collection.groups.map((group) => (
                  <button className={`collection-row group-link ${selectedGroupId === group.id && view === 'groupDetail' ? 'active' : ''}`} key={group.id} onClick={() => openGroupDetail(group.id)}>
                    <span className="dot ghost-dot" />
                    <span className="collection-name">{group.name}</span>
                    <span>{group.favorite ? '★' : ''}</span>
                  </button>
                )) : null}
              </div>
            );
          })}
        </section>
          </>
        ) : (
          <section className="side-section module-summary">
            <div className="section-label">{moduleLabel(module)}</div>
            <SideCounter active icon={moduleIcon(module)} label={moduleSummaryLabel(module)} value={moduleCount(module, privateChats, moments, media)} onClick={() => openModule(module)} />
          </section>
        )}

        <div className="daemon-pill">
          <span className={data?.preflight.ok ? 'status-dot ok' : 'status-dot warn'} />
          <span>{data?.preflight.ok ? '消息服务就绪' : '消息服务待初始化'}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="top-kicker">LOCAL INTELLIGENCE</div>
            <h2>{activeTitle}</h2>
            <p>{scopedRangeLabel}</p>
          </div>
          <div className="controls">
            {period === '自定义' ? (
              <label className="date-control custom-date-control">
                <span>起</span>
                <input type="date" value={range.since} onChange={(event) => changeCustomSince(event.target.value)} />
              </label>
            ) : null}
            <label className="date-control">
              <CalendarDays size={17} />
              <input type="date" value={range.until} onChange={(event) => changeDate(event.target.value)} />
            </label>
            <Segmented options={periodOptions} active={period} onChange={changePeriod} ariaLabel="统计周期" />
            <Segmented options={syncCadenceOptions} active={syncCadence} onChange={setSyncCadence} ariaLabel="自动同步频率" compact />
            <button className="secondary-button" onClick={startFullSync} disabled={syncing}>
              <Database size={17} />
              全量同步
            </button>
            <button className="primary-button" onClick={() => void runIncrementalSync()} disabled={syncing}>
              {syncing ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              重扫
            </button>
          </div>
        </header>

        {loading || !data ? (
          <div className="loading-panel">
            <Loader2 className="spin" size={22} />
            正在读取本地看板
          </div>
        ) : (
          <>
            {module === 'private' && view === 'privateList' ? (
              <PrivateChatListView
                privateChats={privateChats}
                privateQuery={privateQuery}
                setPrivateQuery={setPrivateQuery}
                onSearch={() => loadPrivateChats(privateQuery)}
                onOpen={openPrivateDetail}
              />
            ) : module === 'private' && view === 'privateDetail' ? (
              <GroupDetailView
                detail={privateDetail}
                tab={privateTab}
                setTab={(tab) => {
                  setPrivateTab(tab);
                  void loadPrivateDetail(selectedPrivateId, tab);
                }}
                kind="private"
              />
            ) : module === 'moments' ? (
              <MomentsView
                moments={moments}
                query={momentQuery}
                author={momentAuthor}
                setQuery={setMomentQuery}
                setAuthor={setMomentAuthor}
                onSearch={() => loadMoments(range, momentQuery, momentAuthor)}
                onSelect={(item) => setSelected(momentToSignal(item))}
              />
            ) : module === 'media' ? (
              <MediaView
                media={media}
                query={mediaQuery}
                source={mediaSource}
                kind={mediaKind}
                setQuery={setMediaQuery}
                setSource={(value) => {
                  setMediaSource(value);
                  void loadMedia(range, value, mediaKind, mediaQuery);
                }}
                setKind={(value) => {
                  setMediaKind(value);
                  void loadMedia(range, mediaSource, value, mediaQuery);
                }}
                onSearch={() => loadMedia(range, mediaSource, mediaKind, mediaQuery)}
                onOpenChat={(item) => item.chatType === 'private' ? openPrivateDetail(item.chatId) : openGroupDetail(item.chatId)}
                onPreviewImage={setPreviewImage}
                onPreviewVideo={setPreviewVideo}
              />
            ) : view === 'dashboard' ? (
              <DashboardView data={data} copied={copied} copyBrief={copyBrief} onSelect={setSelected} />
            ) : view === 'feed' ? (
              <FeedView
                feed={feed}
                feedKind={feedKind}
                feedQuery={feedQuery}
                setFeedKind={setFeedKind}
                setFeedQuery={setFeedQuery}
                onSearch={() => loadFeed(range, feedKind, feedQuery, scope)}
                onRefresh={() => loadFeed(range, feedKind, feedQuery, scope)}
                onSelect={setSelected}
              />
            ) : view === 'radar' ? (
              <RadarView radar={radar} onSelect={setSelected} />
            ) : view === 'links' ? (
              <LinksView links={links} onSelect={setSelected} />
            ) : view === 'groups' ? (
              <GroupListView
                groupList={groupList}
                groupScope={groupScope}
                groupQuery={groupQuery}
                setGroupQuery={setGroupQuery}
                onSearch={() => loadGroups(groupScope, groupQuery)}
                onOpen={openGroupDetail}
                onFavorite={toggleGroupFavorite}
              />
            ) : view === 'groupDetail' ? (
              <GroupDetailView
                detail={groupDetail}
                tab={groupTab}
                setTab={(tab) => {
                  setGroupTab(tab);
                  void loadGroupDetail(selectedGroupId, tab);
                }}
                onFavorite={toggleGroupFavorite}
                kind="group"
              />
            ) : view === 'settings' ? (
              <SettingsView preflight={data.preflight} sync={data.sync} />
            ) : (
              <PlaceholderView title={activeTitle} />
            )}
          </>
        )}
      </section>

      {selected ? <DetailDrawer item={selected} onClose={() => setSelected(null)} /> : null}
      {previewImage ? <ImageLightbox message={previewImage} onClose={() => setPreviewImage(null)} /> : null}
      {previewVideo ? <VideoLightbox message={previewVideo} onClose={() => setPreviewVideo(null)} /> : null}
    </main>
  );
}

function NavItem({ icon, label, badge, active, onClick }: { icon: React.ReactNode; label: string; badge: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      <em>{badge}</em>
    </button>
  );
}

function ModuleItem({ icon, label, desc, active, onClick }: { icon: React.ReactNode; label: string; desc: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`module-item ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{desc}</small>
      </span>
    </button>
  );
}

function DashboardView({
  data,
  copied,
  copyBrief,
  onSelect
}: {
  data: Dashboard;
  copied: boolean;
  copyBrief: () => void;
  onSelect: (item: SignalItem) => void;
}) {
  return (
    <>
      <StatusBanner preflight={data.preflight} sync={data.sync} />
      <section className="metrics-grid">
        {data.metrics.map((metric, index) => (
          <MetricCard key={metric.label} metric={metric} index={index} />
        ))}
      </section>

      <section className="brief-panel">
        <div>
          <div className="panel-label">BRIEFING NOTE</div>
          <h3>
            <Target size={18} />
            今日情报简报
          </h3>
          <p>{data.brief}</p>
        </div>
        <button className="copy-button" onClick={copyBrief}>
          <Clipboard size={17} />
          {copied ? '已复制' : '复制摘要'}
        </button>
      </section>

      <section className="content-grid">
        <SignalPanel title="最值得关注" suffix={`${data.topSignals.length} 条高信号`} items={data.topSignals} icon={<Target size={18} />} onSelect={onSelect} empty="暂无高信号，完成同步后自动生成。" />
        <SignalPanel title="可行动项" suffix={`${data.actions.length} 个可跟进`} items={data.actions} icon={<Zap size={18} />} onSelect={onSelect} empty="暂未发现可跟进行动项。" />
        <SourcesPanel items={data.sources} />
      </section>
    </>
  );
}

function GroupListView({
  groupList,
  groupScope,
  groupQuery,
  setGroupQuery,
  onSearch,
  onOpen,
  onFavorite
}: {
  groupList: GroupListResponse | null;
  groupScope: { scope: GroupListScope; label: string; collection: string };
  groupQuery: string;
  setGroupQuery: (value: string) => void;
  onSearch: () => void;
  onOpen: (groupId: string) => void;
  onFavorite: (groupId: string, favorite?: boolean) => Promise<void>;
}) {
  return (
    <>
      <section className="feed-toolbar">
        <div>
          <div className="panel-label">GROUP DIRECTORY</div>
          <h3><UsersRound size={18} />{groupScope.label}</h3>
        </div>
        <label className="feed-search">
          <Search size={17} />
          <input
            value={groupQuery}
            onChange={(event) => setGroupQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            placeholder="搜索群名、分组或 chatroom"
          />
          <button onClick={onSearch}>搜索</button>
        </label>
      </section>

      <section className="group-list-panel panel">
        <div className="panel-heading">
          <h3><Folder size={18} />微信群列表</h3>
          <span>{groupList ? `${groupList.total} 个群` : '读取中'}</span>
        </div>
        {!groupList ? <div className="empty-state">正在读取微信群列表...</div> : null}
        {groupList && groupList.groups.length === 0 ? <div className="empty-state">当前范围没有微信群。</div> : null}
        <div className="group-list">
          {(groupList?.groups ?? []).map((group) => (
            <button className="group-row" key={group.id} onClick={() => onOpen(group.id)}>
              <span className="group-row-main">
                <strong>{group.name}</strong>
                <small>{group.collection} · {group.rawName} · {group.lastMessageAt || '暂无最近消息'}</small>
                <em>{group.sample || '暂无消息摘要'}</em>
              </span>
              <span className="group-row-stats">
                <span>{formatCompact(group.messageCount)} 消息</span>
                <span>{formatCompact(group.signalCount)} 信号</span>
                <span>{formatCompact(group.linkCount)} 链接</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                className={`favorite-toggle ${group.favorite ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void onFavorite(group.id, !group.favorite);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    void onFavorite(group.id, !group.favorite);
                  }
                }}
                aria-label={group.favorite ? '取消收藏' : '收藏'}
              >
                <Star size={17} fill={group.favorite ? 'currentColor' : 'none'} />
              </span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function PrivateChatListView({
  privateChats,
  privateQuery,
  setPrivateQuery,
  onSearch,
  onOpen
}: {
  privateChats: PrivateChatsResponse | null;
  privateQuery: string;
  setPrivateQuery: (value: string) => void;
  onSearch: () => void;
  onOpen: (chatId: string) => void;
}) {
  return (
    <>
      <section className="feed-toolbar">
        <div>
          <div className="panel-label">PRIVATE DIRECTORY</div>
          <h3><MessageCircle size={18} />近期私聊</h3>
        </div>
        <label className="feed-search">
          <Search size={17} />
          <input
            value={privateQuery}
            onChange={(event) => setPrivateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            placeholder="搜索联系人、备注或昵称"
          />
          <button onClick={onSearch}>搜索</button>
        </label>
      </section>

      <section className="panel group-list-panel">
        <div className="panel-heading">
          <h3><MessageCircle size={18} />私聊列表</h3>
          <span>{privateChats?.total ?? 0} 个会话</span>
        </div>
        {privateChats && privateChats.chats.length === 0 ? <div className="empty-state">暂无私聊数据，点击全量同步读取近期私聊。</div> : null}
        <div className="group-list">
          {(privateChats?.chats ?? []).map((chat) => (
            <article className="group-row private-chat-row" key={chat.id}>
              <button className="group-row-main private-chat-main" onClick={() => onOpen(chat.id)}>
                <PersonAvatar profile={chat.profile} fallback={chat.name} />
                <span>
                  <strong>{chat.name}</strong>
                  <small>{chat.lastMessageAt || '暂无时间'} · {chat.sample || chat.profile?.subtitle || '近期私聊'}</small>
                </span>
              </button>
              <span className="group-row-stats">
                <span>{formatCompact(chat.messageCount)} 消息</span>
                <span>{formatCompact(chat.linkCount)} 链接</span>
                <span>{formatCompact(chat.imageCount + chat.videoCount)} 媒体</span>
              </span>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function GroupDetailView({
  detail,
  tab,
  setTab,
  onFavorite,
  kind = 'group'
}: {
  detail: GroupDetail | null;
  tab: GroupTab;
  setTab: (tab: GroupTab) => void;
  onFavorite?: (groupId: string, favorite?: boolean) => Promise<void>;
  kind?: 'group' | 'private';
}) {
  const [previewImage, setPreviewImage] = useState<GroupMessage | null>(null);
  const [previewVideo, setPreviewVideo] = useState<GroupMessage | null>(null);

  if (!detail) {
    return <div className="loading-panel"><Loader2 className="spin" size={22} />正在读取群详情</div>;
  }

  const metrics: Metric[] = [
    { label: '总消息', value: formatCompact(detail.metrics.messages), hint: detail.metrics.lastMessageAt || '暂无最近消息', tone: 'mint' },
    { label: '活跃成员', value: formatCompact(detail.metrics.senders), hint: `${formatCompact(detail.tabs.counts.members)} 个成员/发言者`, tone: 'mint' },
    { label: '高信号', value: formatCompact(detail.metrics.signals), hint: `@我 ${formatCompact(detail.metrics.mentions)} 条`, tone: 'amber' },
    { label: '素材', value: formatCompact(detail.metrics.links + detail.metrics.images + detail.metrics.videos + detail.metrics.files), hint: `${formatCompact(detail.metrics.links)} 链接 · ${formatCompact(detail.metrics.images)} 图片`, tone: 'neutral' }
  ];
  const tabs: Array<{ key: GroupTab; label: string; icon: React.ReactNode }> = [
    ...(kind === 'group' ? [{ key: 'members' as GroupTab, label: '成员', icon: <UsersRound size={17} /> }] : []),
    { key: 'messages', label: '消息', icon: <MessageCircle size={17} /> },
    { key: 'files', label: '文件', icon: <FileText size={17} /> },
    { key: 'links', label: '链接', icon: <Link2 size={17} /> },
    { key: 'videos', label: '视频', icon: <Video size={17} /> },
    { key: 'images', label: '图片', icon: <ImageIcon size={17} /> }
  ];

  return (
    <>
      <section className="group-detail-hero">
        <div className={kind === 'private' ? 'detail-person-heading' : ''}>
          {kind === 'private' ? <PersonAvatar profile={detail.group.profile} fallback={detail.group.name} size="lg" /> : null}
          <span>
            <div className="panel-label">{kind === 'private' ? 'PRIVATE DETAIL' : 'GROUP DETAIL'}</div>
            <h3>{detail.group.name}</h3>
            <p>{kind === 'private' ? `私萃 · ${detail.group.profile?.subtitle || '个人聊天'}` : `${detail.group.collection} · ${detail.group.rawName}`}</p>
          </span>
        </div>
        {kind === 'group' && onFavorite ? <button className={`copy-button favorite-action ${detail.group.favorite ? 'active' : ''}`} onClick={() => onFavorite(detail.group.id, !detail.group.favorite)}>
          <Star size={17} fill={detail.group.favorite ? 'currentColor' : 'none'} />
          {detail.group.favorite ? '已收藏' : '收藏'}
        </button> : null}
      </section>

      <section className="metrics-grid">
        {metrics.map((metric, index) => <MetricCard key={metric.label} metric={metric} index={index} />)}
      </section>

      <section className="group-tabs">
        {tabs.map((item) => (
          <button className={tab === item.key ? 'active' : ''} key={item.key} onClick={() => setTab(item.key)}>
            {item.icon}
            {item.label}
            <span>{formatCompact(detail.tabs.counts[item.key] || 0)}</span>
          </button>
        ))}
      </section>

      <section className="panel group-tab-panel">
        {tab === 'members' ? <MemberTable members={detail.members} /> : null}
        {tab === 'messages' ? <GroupMessageList messages={detail.messages} empty="暂无消息。" onPreviewImage={setPreviewImage} onPreviewVideo={setPreviewVideo} /> : null}
        {tab === 'files' ? <GroupMessageList messages={detail.files} empty="暂无文件。" onPreviewImage={setPreviewImage} onPreviewVideo={setPreviewVideo} /> : null}
        {tab === 'links' ? <GroupLinkList messages={detail.links} /> : null}
        {tab === 'videos' ? <GroupMessageList messages={detail.videos} empty="暂无视频。" onPreviewImage={setPreviewImage} onPreviewVideo={setPreviewVideo} /> : null}
        {tab === 'images' ? <GroupMessageList messages={detail.images} empty="暂无图片。" onPreviewImage={setPreviewImage} onPreviewVideo={setPreviewVideo} /> : null}
      </section>

      {previewImage ? <ImageLightbox message={previewImage} onClose={() => setPreviewImage(null)} /> : null}
      {previewVideo ? <VideoLightbox message={previewVideo} onClose={() => setPreviewVideo(null)} /> : null}
    </>
  );
}

function MemberTable({ members }: { members: GroupMember[] }) {
  if (members.length === 0) return <div className="empty-state">暂无成员信息。</div>;
  return (
    <div className="member-list">
      {members.map((member) => (
        <div className="member-row" key={`${member.name}-${member.alias}`}>
          <PersonAvatar profile={member.profile} fallback={member.name} />
          <span className="source-name">
            <strong>{member.name}</strong>
            <small>{member.profile?.subtitle || member.alias || member.lastSeenAt || '成员'}</small>
          </span>
          <span className="source-score">{member.messageCount ? formatCompact(member.messageCount) : ''}</span>
        </div>
      ))}
    </div>
  );
}

function PersonAvatar({
  profile,
  fallback,
  size = 'md'
}: {
  profile?: ContactProfile;
  fallback: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const label = profile?.displayName || fallback || '微信联系人';
  const initial = profile?.initial || Array.from(label.trim())[0]?.toUpperCase() || '微';
  const avatarUrl = profile?.avatarUrl && !failed ? profile.avatarUrl : '';

  return (
    <span className={`person-avatar ${size}`} title={label}>
      {avatarUrl ? (
        <img src={avatarUrl} alt={`${label} 头像`} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}

function GroupMessageList({
  messages,
  empty,
  onPreviewImage,
  onPreviewVideo
}: {
  messages: GroupMessage[];
  empty: string;
  onPreviewImage?: (message: GroupMessage) => void;
  onPreviewVideo?: (message: GroupMessage) => void;
}) {
  if (messages.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <div className="group-message-list">
      {messages.map((message) => (
        <article className={`group-message-row ${message.image || message.video || message.file || message.link ? 'media-message-row' : ''}`} key={message.id}>
          <span className="feed-time">{message.time}</span>
          <span className="feed-main">
            <span className="feed-title-line">
              <strong>{message.title}</strong>
              <em>{message.type}</em>
            </span>
            <span className="message-sender-line">
              <PersonAvatar profile={message.senderProfile} fallback={message.sender} size="sm" />
              <small>{message.sender}</small>
            </span>
            {message.image ? (
              <ImagePreviewCard message={message} onPreview={() => onPreviewImage?.(message)} />
            ) : message.video ? (
              <button className="video-preview-card" type="button" onClick={() => onPreviewVideo?.(message)}>
                <span className="video-preview-thumb">
                  <Video size={34} />
                </span>
                <span className="video-preview-copy">
                  <strong>视频消息</strong>
                  <small>点击播放 · local_id={message.video.localId}</small>
                </span>
              </button>
            ) : message.file ? (
              <a className="file-preview-card" href={message.file.downloadUrl} download>
                <span className="file-preview-icon">
                  <FileText size={28} />
                </span>
                <span className="file-preview-copy">
                  <strong>{message.file.name}</strong>
                  <small>
                    {message.file.size ? `${message.file.size} · ` : ''}
                    {message.file.extension.toUpperCase()} · 点击下载
                  </small>
                </span>
              </a>
            ) : message.link ? (
              <a className="link-preview-card" href={message.link.url} target="_blank" rel="noreferrer">
                <span className="link-preview-icon">
                  <Link2 size={26} />
                </span>
                <span className="link-preview-copy">
                  <strong>{message.link.title}</strong>
                  <small>{message.link.domain}</small>
                  <em>{message.link.url}</em>
                </span>
              </a>
            ) : (
              <span className="feed-content">{message.content}</span>
            )}
          </span>
        </article>
      ))}
    </div>
  );
}

function ImageLightbox({ message, onClose }: { message: GroupMessage; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={onClose}>
      <div className="image-lightbox-inner" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-bar">
          <span>
            <strong>{message.sender}</strong>
            <small>{message.time} · local_id={message.image?.localId}</small>
          </span>
          <button className="icon-button" type="button" aria-label="关闭图片预览" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {failed ? (
          <div className="video-unavailable">
            <ImageIcon size={34} />
            <strong>本机未缓存该图片</strong>
            <span>请先在微信里打开这条图片后，再回到看板重试。</span>
          </div>
        ) : (
          <img src={message.image?.fullUrl} alt={`${message.sender} 发送的完整图片`} onError={() => setFailed(true)} />
        )}
      </div>
    </div>
  );
}

function ImagePreviewCard({ message, onPreview }: { message: GroupMessage; onPreview: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button className="image-preview-card" type="button" onClick={onPreview}>
      {failed ? (
        <span className="image-preview-fallback">
          <ImageIcon size={26} />
          <strong>图片消息</strong>
          <small>本机未缓存预览</small>
        </span>
      ) : (
        <img src={message.image?.previewUrl} alt={`${message.sender} 发送的图片`} loading="lazy" onError={() => setFailed(true)} />
      )}
      <span className="image-preview-meta">
        <ImageIcon size={16} />
        local_id={message.image?.localId}
      </span>
    </button>
  );
}

function VideoLightbox({ message, onClose }: { message: GroupMessage; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="视频播放" onClick={onClose}>
      <div className="image-lightbox-inner video-lightbox-inner" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-bar">
          <span>
            <strong>{message.sender}</strong>
            <small>{message.time} · local_id={message.video?.localId}</small>
          </span>
          <button className="icon-button" type="button" aria-label="关闭视频播放" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {failed ? (
          <div className="video-unavailable">
            <Video size={34} />
            <strong>本机未缓存该视频</strong>
            <span>请先在微信里打开或下载这条视频后，再回到看板重试。</span>
          </div>
        ) : (
          <video src={message.video?.fullUrl} controls autoPlay playsInline onError={() => setFailed(true)} />
        )}
      </div>
    </div>
  );
}

function GroupLinkList({ messages }: { messages: GroupMessage[] }) {
  if (messages.length === 0) return <div className="empty-state">暂无链接。</div>;
  return (
    <div className="link-list">
      {messages.map((message, index) => (
        <a className="link-row" href={message.link?.url || message.url} target="_blank" rel="noreferrer" key={`${message.id}-${message.link?.url || message.url || 'link'}-${index}`}>
          <span className="link-domain">{message.link?.domain || message.domain}</span>
          <span className="link-main">
            <strong>{message.link?.title || message.title}</strong>
            <small>{message.sender} · {message.time}</small>
            <em>{message.link?.url || message.url}</em>
          </span>
        </a>
      ))}
    </div>
  );
}

function MomentsView({
  moments,
  query,
  author,
  setQuery,
  setAuthor,
  onSearch,
  onSelect
}: {
  moments: MomentsResponse | null;
  query: string;
  author: string;
  setQuery: (value: string) => void;
  setAuthor: (value: string) => void;
  onSearch: () => void;
  onSelect: (item: MomentItem) => void;
}) {
  const metrics: Metric[] = [
    { label: '朋友圈', value: formatCompact(moments?.metrics.posts ?? 0), hint: '范围内动态', tone: 'mint' },
    { label: '作者', value: formatCompact(moments?.metrics.authors ?? 0), hint: '活跃来源', tone: 'neutral' },
    { label: '媒体', value: formatCompact(moments?.metrics.media ?? 0), hint: '图片 / 视频线索', tone: 'amber' },
    { label: '互动', value: formatCompact(moments?.metrics.notifications ?? 0), hint: '点赞 / 评论通知', tone: 'neutral' }
  ];

  return (
    <>
      <section className="feed-toolbar">
        <div>
          <div className="panel-label">MOMENTS FLOW</div>
          <h3><Sparkles size={18} />朋友圈时间线</h3>
        </div>
        <label className="feed-search moments-search">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            placeholder="搜索朋友圈正文或作者"
          />
          <input
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            placeholder="作者"
          />
          <button onClick={onSearch}>搜索</button>
        </label>
      </section>

      <section className="metrics-grid compact-metrics">
        {metrics.map((metric, index) => <MetricCard key={metric.label} metric={metric} index={index} />)}
      </section>

      <section className="moments-layout">
        <article className="panel moment-list-panel">
          <div className="panel-heading">
            <h3><Sparkles size={18} />圈萃内容</h3>
            <span>{moments?.total ?? 0} 条</span>
          </div>
          {(moments?.items ?? []).length === 0 ? <div className="empty-state">暂无朋友圈缓存数据，点击全量同步读取本机缓存。</div> : null}
          <div className="moment-list">
            {(moments?.items ?? []).map((item) => (
              <button className="moment-row" key={item.id} onClick={() => onSelect(item)}>
                <PersonAvatar profile={item.authorProfile} fallback={item.authorName || item.author} />
                <span className="moment-main">
                  <strong>{item.authorName || item.author}</strong>
                  <small>{item.authorProfile?.subtitle || '朋友圈作者'} · {item.time}{item.location ? ` · ${item.location}` : ''}</small>
                  <em>{item.content || '无正文内容'}</em>
                </span>
                <span className="group-chip">{item.mediaCount} 媒体</span>
              </button>
            ))}
          </div>
        </article>

        <article className="panel moment-author-panel">
          <div className="panel-heading">
            <h3><UserRoundSearch size={18} />作者</h3>
            <span>{moments?.authors.length ?? 0} 人</span>
          </div>
          <div className="source-list">
            {(moments?.authors ?? []).map((item, index) => (
              <button className="source-row clickable" key={item.username || item.name} onClick={() => {
                setAuthor(item.name);
                window.setTimeout(onSearch, 0);
              }}>
                <PersonAvatar profile={item.profile} fallback={item.name} size="sm" />
                <span className="source-name">
                  <strong>{item.name}</strong>
                  <small>#{index + 1} · {item.profile?.subtitle || '作者'} · {item.lastTime}</small>
                </span>
                <span className="source-score">{item.count}</span>
              </button>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

function MediaView({
  media,
  query,
  source,
  kind,
  setQuery,
  setSource,
  setKind,
  onSearch,
  onOpenChat,
  onPreviewImage,
  onPreviewVideo
}: {
  media: MediaResponse | null;
  query: string;
  source: MediaSource;
  kind: MediaKind;
  setQuery: (value: string) => void;
  setSource: (value: MediaSource) => void;
  setKind: (value: MediaKind) => void;
  onSearch: () => void;
  onOpenChat: (item: MediaItem) => void;
  onPreviewImage: (message: GroupMessage) => void;
  onPreviewVideo: (message: GroupMessage) => void;
}) {
  const metrics: Metric[] = [
    { label: '图片', value: formatCompact(media?.metrics.images ?? 0), hint: '聊天图片', tone: 'mint' },
    { label: '视频', value: formatCompact(media?.metrics.videos ?? 0), hint: '聊天视频', tone: 'amber' },
    { label: '会话', value: formatCompact(media?.metrics.chats ?? 0), hint: '群聊 + 私聊', tone: 'neutral' },
    { label: '发送者', value: formatCompact(media?.metrics.senders ?? 0), hint: '素材来源', tone: 'neutral' }
  ];

  return (
    <>
      <section className="feed-toolbar">
        <div>
          <div className="panel-label">MEDIA INDEX</div>
          <h3><ImageIcon size={18} />影萃检索</h3>
        </div>
        <label className="feed-search">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch();
            }}
            placeholder="搜索会话、发送者或描述"
          />
          <button onClick={onSearch}>搜索</button>
        </label>
      </section>

      <section className="filter-row">
        <Segmented options={['all', 'group', 'private'] as MediaSource[]} active={source} onChange={setSource} ariaLabel="媒体来源" />
        <Segmented options={['all', 'image', 'video'] as MediaKind[]} active={kind} onChange={setKind} ariaLabel="媒体类型" />
      </section>

      <section className="metrics-grid compact-metrics">
        {metrics.map((metric, index) => <MetricCard key={metric.label} metric={metric} index={index} />)}
      </section>

      <section className="panel media-panel">
        <div className="panel-heading">
          <h3><ImageIcon size={18} />媒体卡片</h3>
          <span>{media?.total ?? 0} 个</span>
        </div>
        {(media?.items ?? []).length === 0 ? <div className="empty-state">暂无媒体索引，完成群萃或私萃同步后自动显示。</div> : null}
        <div className="media-grid">
          {(media?.items ?? []).map((item) => (
            <article className="media-card" key={item.id}>
              {item.image ? (
                <ImagePreviewCard message={item} onPreview={() => onPreviewImage(item)} />
              ) : item.video ? (
                <button className="video-preview-card" type="button" onClick={() => onPreviewVideo(item)}>
                  <span className="video-preview-thumb"><Video size={34} /></span>
                  <span className="video-preview-copy">
                    <strong>视频消息</strong>
                    <small>点击播放 · local_id={item.video.localId}</small>
                  </span>
                </button>
              ) : null}
              <div className="media-card-body">
                <strong>{item.chatName}</strong>
                <span className="media-sender-line">
                  <PersonAvatar profile={item.senderProfile} fallback={item.sender} size="sm" />
                  <small>{item.sourceLabel} · {item.sender} · {item.time}</small>
                </span>
                <p>{item.title}</p>
                <button className="secondary-button inline-action" onClick={() => onOpenChat(item)}>打开会话</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function FeedView({
  feed,
  feedKind,
  feedQuery,
  setFeedKind,
  setFeedQuery,
  onSearch,
  onRefresh,
  onSelect
}: {
  feed: FeedResponse | null;
  feedKind: FeedKind;
  feedQuery: string;
  setFeedKind: (kind: FeedKind) => void;
  setFeedQuery: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onSelect: (item: SignalItem) => void;
}) {
  const stats = feed?.stats;
  const filters: Array<{ key: FeedKind; label: string; value: number; icon: React.ReactNode }> = [
    { key: 'all', label: '全部消息', value: stats?.messages ?? 0, icon: <Clock size={17} /> },
    { key: 'signals', label: '高信号', value: stats?.signals ?? 0, icon: <Signal size={17} /> },
    { key: 'actions', label: '可跟进', value: stats?.actions ?? 0, icon: <Zap size={17} /> },
    { key: 'mentions', label: '@ 我', value: stats?.mentions ?? 0, icon: <AtSign size={17} /> },
    { key: 'links', label: '链接', value: stats?.links ?? 0, icon: <Link2 size={17} /> }
  ];

  return (
    <>
      <section className="feed-toolbar">
        <div>
          <div className="panel-label">SIGNAL STREAM</div>
          <h3><Activity size={18} />按时间倒序的微信群消息流</h3>
        </div>
        <div className="feed-tools">
          <label className="feed-search">
            <Search size={17} />
            <input
              value={feedQuery}
              onChange={(event) => setFeedQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSearch();
              }}
              placeholder="搜索内容、群名或发送者"
            />
            <button onClick={onSearch}>搜索</button>
          </label>
          <button className="secondary-button" onClick={onRefresh}>
            <Activity size={17} />
            刷新流
          </button>
        </div>
      </section>

      <section className="feed-filter-grid">
        {filters.map((filter) => (
          <button className={`feed-filter ${feedKind === filter.key ? 'active' : ''}`} key={filter.key} onClick={() => setFeedKind(filter.key)}>
            <span>{filter.icon}{filter.label}</span>
            <strong>{formatCompact(filter.value)}</strong>
          </button>
        ))}
      </section>

      <section className="feed-layout">
        <article className="panel feed-panel">
          <div className="panel-heading">
            <h3><Filter size={18} />实时信号</h3>
            <span>{feed ? `${formatCompact(feed.total)} 条` : '读取中'}</span>
          </div>
          {!feed ? <div className="empty-state">正在读取信号流...</div> : null}
          {feed && feed.items.length === 0 ? <div className="empty-state">当前筛选没有匹配消息。</div> : null}
          <div className="feed-list">
            {(feed?.items ?? []).map((item) => (
              <button className={`feed-row kind-${item.kind}`} key={item.id} onClick={() => onSelect(item)}>
                <span className="feed-time">{item.time}</span>
                <span className="feed-main">
                  <span className="feed-title-line">
                    <strong>{item.title}</strong>
                    {item.score > 0 ? <em>{item.score}</em> : null}
                  </span>
                  <small>{item.groupName} · {item.sender} · {item.absoluteTime}</small>
                  <span className="feed-content">{item.content}</span>
                  <span className="tags">{item.tags.map((tag) => <em key={tag}>{tag}</em>)}</span>
                </span>
              </button>
            ))}
          </div>
        </article>

        <aside className="feed-side">
          <article className="panel compact-panel">
            <div className="panel-heading">
              <h3><UsersRound size={18} />活跃群</h3>
              <span>Top 10</span>
            </div>
            <div className="source-list">
              {(feed?.groups ?? []).map((group, index) => (
                <div className="source-row" key={group.name}>
                  <span className="rank">{index + 1}</span>
                  <span className="source-name">
                    <strong>{group.name}</strong>
                    <small>{group.lastTime}</small>
                  </span>
                  <span className="source-score">{group.count}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="panel compact-panel">
            <div className="panel-heading">
              <h3><Hash size={18} />消息类型</h3>
              <span>分布</span>
            </div>
            <div className="type-list">
              {(feed?.types ?? []).map((item) => (
                <div className="type-row" key={item.name}>
                  <span>{item.name}</span>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          </article>
        </aside>
      </section>
    </>
  );
}

function RadarView({ radar, onSelect }: { radar: RadarResponse | null; onSelect: (item: SignalItem) => void }) {
  return (
    <>
      <section className="insight-hero">
        <div>
          <div className="panel-label">TOPIC RADAR</div>
          <h3><Sparkles size={18} />本地话题聚类</h3>
          <p>{radar ? `${radar.scope.label} · 扫描 ${formatCompact(radar.totalMessages)} 条消息 · ${radar.topics.length} 个活跃话题` : '正在读取话题雷达...'}</p>
        </div>
      </section>

      <section className="radar-layout">
        <article className="panel radar-panel">
          <div className="panel-heading">
            <h3><Target size={18} />高频话题</h3>
            <span>{radar?.topics.length ?? 0} 个</span>
          </div>
          {!radar ? <div className="empty-state">正在分析本地消息...</div> : null}
          {radar && radar.topics.length === 0 ? <div className="empty-state">当前范围暂无可聚类话题。</div> : null}
          <div className="topic-grid">
            {(radar?.topics ?? []).map((topic, index) => (
              <article className="topic-card" key={topic.name}>
                <div className="topic-card-head">
                  <span className="rank">{index + 1}</span>
                  <strong>{topic.name}</strong>
                  <em>{topic.score}</em>
                </div>
                <div className="topic-meta">
                  <span>{formatCompact(topic.count)} 条消息</span>
                  <span>{topic.groups} 群</span>
                </div>
                <div className="topic-examples">
                  {topic.examples.slice(0, 3).map((item) => (
                    <button key={item.id} onClick={() => onSelect(item)}>
                      <span>{item.title}</span>
                      <small>{item.groupName} · {item.sender}</small>
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </article>

        <aside className="panel keyword-panel">
          <div className="panel-heading">
            <h3><Hash size={18} />热词</h3>
            <span>Top 24</span>
          </div>
          <div className="keyword-cloud">
            {(radar?.keywords ?? []).map((item) => (
              <button key={item.name} className="keyword-pill">
                <span>{item.name}</span>
                <em>{item.count}</em>
              </button>
            ))}
          </div>
        </aside>
      </section>
    </>
  );
}

function LinksView({ links, onSelect }: { links: LinksResponse | null; onSelect: (item: SignalItem) => void }) {
  return (
    <>
      <section className="insight-hero">
        <div>
          <div className="panel-label">LINK INTELLIGENCE</div>
          <h3><Link2 size={18} />本地链接情报</h3>
          <p>{links ? `${links.scope.label} · ${formatCompact(links.totalLinks)} 条链接 · ${links.domains.length} 个高频域名` : '正在读取链接情报...'}</p>
        </div>
      </section>

      <section className="links-layout">
        <article className="panel link-panel">
          <div className="panel-heading">
            <h3><Link2 size={18} />链接流</h3>
            <span>{formatCompact(links?.items.length ?? 0)} 条</span>
          </div>
          {!links ? <div className="empty-state">正在提取链接...</div> : null}
          {links && links.items.length === 0 ? <div className="empty-state">当前范围暂无链接消息。</div> : null}
          <div className="link-list">
            {(links?.items ?? []).map((item) => (
              <button className="link-row" key={item.id} onClick={() => onSelect(item)}>
                <span className="link-domain">{item.domain}</span>
                <span className="link-main">
                  <strong>{item.title}</strong>
                  <small>{item.groupName} · {item.sender} · {item.time}</small>
                  <em>{item.url}</em>
                </span>
                <span className="score">{item.score}</span>
              </button>
            ))}
          </div>
        </article>

        <aside className="panel domain-panel">
          <div className="panel-heading">
            <h3><Database size={18} />域名排行</h3>
            <span>Top 12</span>
          </div>
          <div className="type-list">
            {(links?.domains ?? []).map((item, index) => (
              <div className="source-row" key={item.domain}>
                <span className="rank">{index + 1}</span>
                <span className="source-name">
                  <strong>{item.domain}</strong>
                  <small>{item.lastTime}</small>
                </span>
                <span className="source-score">{item.count}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>
    </>
  );
}

function SettingsView({ preflight, sync }: { preflight: Preflight; sync: SyncStatus }) {
  const rows = [
    ['服务组件', preflight.wxFound ? '已安装' : '未安装'],
    ['配置状态', preflight.configFound ? '已完成' : '待初始化'],
    ['后台服务', preflight.daemonOk ? '运行中' : '未运行'],
    ['消息读取', preflight.sessionsOk ? '可读取' : '不可读取'],
    ['同步状态', sync.running ? sync.phase : sync.error ? `失败：${sync.error}` : '空闲']
  ];

  return (
    <section className="settings-layout">
      <article className="panel settings-panel">
        <div className="panel-heading">
          <h3><Settings size={18} />消息服务状态</h3>
          <span>{preflight.ok ? 'READY' : 'CHECK'}</span>
        </div>
        <div className="settings-list">
          {rows.map(([label, value]) => (
            <div className="settings-row" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </article>

      <article className="panel settings-panel">
        <div className="panel-heading">
          <h3><CheckCircle2 size={18} />初始化步骤</h3>
          <span>LOCAL</span>
        </div>
        <ol className="settings-steps">
          {preflight.instructions.map((item) => <li key={item}>{item}</li>)}
        </ol>
      </article>
    </section>
  );
}

function PlaceholderView({ title }: { title: string }) {
  return (
    <section className="placeholder-panel">
      <Sparkles size={22} />
      <div>
        <strong>{title}</strong>
        <span>该模块的入口已预留，当前优先完成信号流 Live。</span>
      </div>
    </section>
  );
}

function SideCounter({ icon, label, value, active, onClick }: { icon: React.ReactNode; label: string; value: number; active?: boolean; onClick: () => void }) {
  return (
    <button className={`side-counter ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="side-counter-label">{icon}{label}</span>
      <span>{value}</span>
    </button>
  );
}

function Segmented<T extends string>({
  options,
  active,
  compact,
  onChange,
  ariaLabel
}: {
  options: T[];
  active: T;
  compact?: boolean;
  onChange: (option: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className={`segmented ${compact ? 'compact' : ''}`} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          className={option === active ? 'selected' : ''}
          key={option}
          type="button"
          aria-pressed={option === active}
          onClick={() => onChange(option)}
        >
          {segmentLabel(option)}
        </button>
      ))}
    </div>
  );
}

function MetricCard({ metric, index }: { metric: Metric; index: number }) {
  const icons = [<Signal size={18} />, <MessageCircle size={18} />, <Bell size={18} />, <Activity size={18} />];
  return (
    <article className={`metric-card tone-${metric.tone ?? 'neutral'}`}>
      <div className="metric-top">
        <span>{icons[index] ?? <Hash size={18} />}{metric.label}</span>
        <em>METRIC</em>
      </div>
      <strong>{metric.value}</strong>
      <p>{metric.hint}</p>
    </article>
  );
}

function StatusBanner({ preflight, sync }: { preflight: Preflight; sync: SyncStatus }) {
  if (sync.running) {
    const progress = sync.totalGroups ? `${sync.processedGroups ?? 0}/${sync.totalGroups}` : '准备中';
    return (
      <section className="status-banner ok">
        <Loader2 className="spin" size={18} />
        <div>
          <strong>{sync.phase} · {progress}</strong>
          <span>{sync.current ? `正在处理：${sync.current}` : '正在读取本地消息数据'}</span>
        </div>
      </section>
    );
  }

  if (sync.error) {
    return (
      <section className="status-banner warn">
        <Bell size={18} />
        <div>
          <strong>上次同步失败</strong>
          <span>消息服务同步失败，请稍后重试或到设置页检查本机状态。</span>
        </div>
      </section>
    );
  }

  if (preflight.ok) {
    return (
      <section className="status-banner ready">
        <CheckCircle2 size={18} />
        <div>
          <strong>消息服务已就绪</strong>
          <span>本地消息索引可用，可开始同步近 30 天微信群数据。</span>
        </div>
      </section>
    );
  }

  return (
    <section className="status-banner warn">
      <Search size={18} />
      <div>
        <strong>消息服务尚未完成初始化</strong>
        <span>请到设置页检查本机服务状态，完成初始化后点击重扫。</span>
      </div>
    </section>
  );
}

function SignalPanel({
  title,
  suffix,
  items,
  icon,
  empty,
  onSelect
}: {
  title: string;
  suffix: string;
  items: SignalItem[];
  icon: React.ReactNode;
  empty: string;
  onSelect: (item: SignalItem) => void;
}) {
  return (
    <article className="panel signal-panel">
      <div className="panel-heading">
        <h3>{icon}{title}</h3>
        <span>{suffix}</span>
      </div>
      {items.length === 0 ? <div className="empty-state">{empty}</div> : null}
      <div className="signal-list">
        {items.map((item) => (
          <button className="signal-row" key={item.id} onClick={() => onSelect(item)}>
            <span className="rank">{item.rank}</span>
            <span className="signal-body">
              <strong>{item.title}</strong>
              <small>{item.groupName} · {item.sender} · {item.time}</small>
              <span className="tags">
                {item.tags.map((tag) => <em key={tag}>{tag}</em>)}
              </span>
            </span>
            <span className="score">{item.score}</span>
          </button>
        ))}
      </div>
    </article>
  );
}

function SourcesPanel({ items }: { items: SourceItem[] }) {
  return (
    <article className="panel sources-panel">
      <div className="panel-heading">
        <h3><UserRoundSearch size={18} />情报源</h3>
        <span>{items.length} 人</span>
      </div>
      {items.length === 0 ? <div className="empty-state">完成同步后显示高价值发言来源。</div> : null}
      <div className="source-list">
        {items.map((item) => (
          <div className="source-row" key={`${item.rank}-${item.name}`}>
            <span className="rank">{item.rank}</span>
            <span className="source-name">
              <strong>{item.name}</strong>
              <small>{item.subtitle}</small>
            </span>
            <span className="source-score">{item.groupCount}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function DetailDrawer({ item, onClose }: { item: SignalItem; onClose: () => void }) {
  return (
    <aside className="drawer">
      <button className="drawer-scrim" onClick={onClose} aria-label="关闭详情" />
      <section className="drawer-panel">
        <button className="icon-button close-button" onClick={onClose}>×</button>
        <div className="panel-label">MESSAGE DETAIL</div>
        <h3>{item.title}</h3>
        <dl>
          <dt>群聊</dt>
          <dd>{item.groupName}</dd>
          <dt>发送者</dt>
          <dd>{item.sender}</dd>
          <dt>时间</dt>
          <dd>{item.time}</dd>
          <dt>分数</dt>
          <dd>{item.score}</dd>
        </dl>
        <div className="drawer-tags">
          {item.tags.map((tag) => <em key={tag}>{tag}</em>)}
        </div>
        <p>{item.content}</p>
      </section>
    </aside>
  );
}

function makePresetRange(until: string, preset: RangePreset) {
  const days: Record<Exclude<RangePreset, '自定义'>, number> = {
    日: 1,
    周: 7,
    月: 30,
    季: 90,
    年: 365
  };
  const end = parseDateOnly(until);
  const span = preset === '自定义' ? 30 : days[preset];
  return {
    since: formatDateOnly(addDays(end, -(span - 1))),
    until: formatDateOnly(end)
  };
}

function normalizeCustomRange(since: string, until: string) {
  const start = parseDateOnly(since);
  const end = parseDateOnly(until);
  if (start.getTime() <= end.getTime()) return { since: formatDateOnly(start), until: formatDateOnly(end) };
  return { since: formatDateOnly(end), until: formatDateOnly(start) };
}

function rangeDays(range: { since: string; until: string }) {
  const start = parseDateOnly(range.since).getTime();
  const end = parseDateOnly(range.until).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function moduleToSyncScope(module: AppModule) {
  if (module === 'private') return 'private';
  if (module === 'moments') return 'moments';
  if (module === 'media') return 'media';
  return 'group';
}

function segmentLabel(value: string) {
  const labels: Record<string, string> = {
    all: '全部',
    group: '群聊',
    private: '私聊',
    image: '图片',
    video: '视频'
  };
  return labels[value] || value;
}

function moduleLabel(module: AppModule) {
  if (module === 'private') return '私萃';
  if (module === 'moments') return '圈萃';
  if (module === 'media') return '影萃';
  return '群萃';
}

function moduleSummaryLabel(module: AppModule) {
  if (module === 'private') return '近期私聊';
  if (module === 'moments') return '朋友圈';
  if (module === 'media') return '媒体素材';
  return '群聊';
}

function moduleIcon(module: AppModule) {
  if (module === 'private') return <MessageCircle size={18} />;
  if (module === 'moments') return <Sparkles size={18} />;
  if (module === 'media') return <ImageIcon size={18} />;
  return <UsersRound size={18} />;
}

function moduleCount(module: AppModule, privateChats: PrivateChatsResponse | null, moments: MomentsResponse | null, media: MediaResponse | null) {
  if (module === 'private') return privateChats?.total ?? 0;
  if (module === 'moments') return moments?.total ?? 0;
  if (module === 'media') return media?.total ?? 0;
  return 0;
}

function momentToSignal(item: MomentItem): SignalItem {
  return {
    id: item.id,
    rank: 0,
    title: item.content || `${item.author} 的朋友圈`,
    groupName: '朋友圈',
    sender: item.author,
    time: item.time,
    tags: ['圈萃', item.mediaCount ? `${item.mediaCount} 媒体` : '文本'],
    score: item.mediaCount,
    kind: 'message',
    content: item.content || '无正文内容'
  };
}

function todayDateOnly() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(`${todayDateOnly()}T00:00:00`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateOnly(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function readSyncCadence(): SyncCadence {
  try {
    const value = window.localStorage.getItem('wxlocal.syncCadence');
    return syncCadenceOptions.includes(value as SyncCadence) ? value as SyncCadence : '自动';
  } catch {
    return '自动';
  }
}

function formatCompact(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: value > 9999 ? 'compact' : 'standard' }).format(value);
}

function collectionColor(index: number) {
  const colors = ['#ef5f5f', '#64d982', '#4db4d7', '#4b9cec', '#7067ff', '#e45ca7', '#a970ff', '#55c795', '#f0a83d', '#e7c649', '#8f6df2', '#f47e43'];
  return colors[index % colors.length];
}

createRoot(document.getElementById('root')!).render(<App />);
