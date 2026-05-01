export type ExtensionMessage =
  | { type: 'updateItems'; tiers: TierData[] }
  | { type: 'updateSources'; providers: SourceProviderData[] }
  | { type: 'selectItem'; itemId: string }
  | { type: 'updateWatches'; watches: WatchData[] };

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
  | { type: 'switchTab'; tab: 'myWork' | 'sources' };

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
  relativeTime: string;
  badges: BadgeData[];
  branchName?: string;
  repoName?: string;
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

export interface WatchData {
  id: string;
}
