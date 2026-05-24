export type WxPreflight = {
  ok: boolean;
  wxFound: boolean;
  configFound: boolean;
  daemonOk: boolean;
  sessionsOk: boolean;
  daemonMessage?: string;
  sessionsMessage?: string;
  instructions: string[];
};

export type SyncStatus = {
  running: boolean;
  runId?: number;
  phase: string;
  current?: string;
  totalGroups?: number;
  processedGroups?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type DashboardRange = {
  since: string;
  until: string;
};

export type DashboardMetric = {
  label: string;
  value: string;
  hint: string;
  tone?: 'mint' | 'amber' | 'neutral';
};

export type SignalItem = {
  id: number;
  rank: number;
  title: string;
  groupName: string;
  sender: string;
  time: string;
  tags: string[];
  score: number;
  kind: 'signal' | 'action';
  content: string;
};

export type SourceItem = {
  rank: number;
  name: string;
  subtitle: string;
  score: number;
  groupCount: number;
};

export type CollectionItem = {
  name: string;
  count: number;
  color: string;
};

export type DashboardResponse = {
  range: DashboardRange;
  preflight: WxPreflight;
  sync: SyncStatus;
  metrics: DashboardMetric[];
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
