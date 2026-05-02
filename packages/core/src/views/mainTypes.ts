export type ExtensionMessage =
  | { type: 'updateItems'; tiers: TierData[] }
  | { type: 'updateSources'; providers: SourceProviderData[] }
  | { type: 'selectItem'; itemId: string }
  | { type: 'updateWatches'; watches: WatchData[] }
  | { type: 'updateWatchPanel'; prWatches: PRWatchData[]; runWatches: RunWatchData[] }
  | { type: 'updateEditorItem'; item: EditorItemData }
  | { type: 'updateTitle'; title: string };

export type WebviewMessage =
  | { type: 'openItem'; itemId: string }
  | { type: 'acceptItem'; providerId: string; externalId: string }
  | { type: 'acceptAll' }
  | { type: 'dismissItem'; providerId: string; externalId: string }
  | { type: 'transitionState'; itemId: string; targetState: string }
  | { type: 'reorderItems'; itemIds: string[] }
  | { type: 'createItem' }
  | { type: 'clearHistory' }
  | { type: 'runAction'; itemId: string }
  | { type: 'openUrl'; url: string }
  | { type: 'openWatchUrl'; url: string }
  | { type: 'dismissCompletedWatches' }
  | { type: 'dismissWatch'; watchId: string }
  | { type: 'switchTab'; tab: 'myWork' | 'sources' }
  | { type: 'autosave'; data: { title?: string; notes?: string; url?: string } };

export interface TierData {
  id: string;
  name: string;
  icon: string;
  items: ItemCardData[];
  collapsed: boolean;
}

export interface ItemCardData {
  id: string;
  title: string;
  badges: BadgeData[];
  branchName?: string;
  /** Compact repo/source label rendered inline next to the title (e.g. "owner/repo"). */
  repoAnnotation?: string;
  tierType: 'incoming' | 'inProgress' | 'readyToStart' | 'paused' | 'done';
  isUnseen?: boolean;
  isUrgent?: boolean;
  isSelected?: boolean;
  providerId?: string;
  externalId?: string;
}

export interface BadgeData {
  label: string;
  type: 'provider' | 'state' | 'ci';
  variant: string;
}

export interface EditorItemData {
  id: string;
  title: string;
  notes?: string;
  url?: string;
  description?: string;
  state: string;
  providerLabel?: string;
  providerState?: string;
  group?: string;
  createdAt: number;
  updatedAt: number;
  badges: BadgeData[];
  branchName?: string;
  repoName?: string;
  isProviderManaged: boolean;
  validTransitions: string[];
  hasActions: boolean;
  activityLog: Array<{ timestamp: number; type: string; detail?: string }>;
  relatedItems: Array<{ id: string; title: string; state: string; badges: BadgeData[] }>;
  isIncoming?: boolean;
  providerId?: string;
  externalId?: string;
}

export interface SourceProviderData {
  providerId: string;
  label: string;
  isHealthy: boolean;
  groups: SourceGroupData[];
}

export interface SourceGroupData {
  name: string;
  items: SourceItemData[];
}

export interface SourceItemData {
  externalId: string;
  providerId: string;
  title: string;
  badges: BadgeData[];
  isAccepted: boolean;
  isDismissed: boolean;
}

export interface PRWatchData {
  id: string;
  title: string;
  repo: string;
  state: 'open' | 'merged' | 'closed';
  url?: string;
  runs: RunWatchData[];
  hasWarning?: boolean;
  errorMessage?: string;
}

export interface RunWatchData {
  id: string;
  name: string;
  repo: string;
  state: 'queued' | 'in_progress' | 'completed';
  conclusion?: string;
  url?: string;
  elapsedTime?: string;
  hasWarning?: boolean;
  errorMessage?: string;
  failurePreview?: string;
}

export interface WatchData {
  id: string;
}
