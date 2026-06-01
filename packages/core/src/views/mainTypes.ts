import type { RunConclusion } from '@devdocket/shared';
import type { ActivityDetailRender } from '../api/types';
import type { ResolvedRelatedItem } from './relatedItemTypes';

export type ExtensionMessage =
  | { type: 'updateItems'; tiers: TierData[] }
  | { type: 'updateSources'; providers: SourceProviderData[] }
  | { type: 'updateCIBadges'; changes: CIBadgeChangeData[] }
  | { type: 'selectItem'; itemId: string }
  | { type: 'toggleSearch' }
  | { type: 'updateWatches'; watches: WatchData[] }
  | { type: 'updateWatchPanel'; prWatches: PRWatchData[]; runWatches: RunWatchData[] }
  | { type: 'updateEditorItem'; item: EditorItemData }
  | { type: 'updateTitle'; title: string }
  | { type: 'autosaveAck'; requestId: string; savedAt: number }
  | { type: 'autosaveError'; requestId: string; message: string };

export type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'openItem'; itemId: string; providerId?: string; externalId?: string }
  | { type: 'openSourceItem'; providerId: string; externalId: string }
  | { type: 'showProviderHealth'; providerId: string }
  | { type: 'acceptItem'; providerId: string; externalId: string }
  | { type: 'acceptToFocus'; providerId: string; externalId: string }
  | { type: 'acceptAll'; items?: Array<{ providerId: string; externalId: string }> }
  | { type: 'dismissItem'; providerId: string; externalId: string }
  | { type: 'transitionState'; itemId: string; targetState: string }
  | { type: 'bulkTransition'; itemIds: string[]; targetState: string }
  | { type: 'bulkInboxAction'; action: 'accept' | 'dismiss'; items: Array<{ providerId: string; externalId: string }> }
  | { type: 'reorderItems'; itemIds: string[] }
  | { type: 'createItem' }
  | { type: 'openWalkthrough' }
  | { type: 'browseProviderExtensions' }
  | { type: 'clearHistory' }
  | { type: 'runAction'; itemId: string }
  | { type: 'openWatches' }
  | { type: 'openUrl'; url: string }
  | { type: 'openWatchUrl'; url: string }
  | { type: 'dismissCompletedWatches' }
  | { type: 'dismissWatch'; watchId: string }
  | { type: 'switchTab'; tab: 'myWork' | 'sources' }
  | { type: 'autosave'; requestId: string; data: { title?: string; notes?: string; url?: string } }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'openWorktree'; itemId: string }
  | { type: 'addWatchUrl' }
  | { type: 'markSeen'; providerId: string; externalId: string }
  | { type: 'crossTierDrop'; itemId: string; targetTier: string }
  | { type: 'requestToggleSearch' }
  | { type: 'watchPanelReady' };

export interface TierData {
  id: string;
  name: string;
  icon: string;
  items: ItemCardData[];
  collapsed: boolean;
}

export interface ItemAuthorData {
  displayName: string;
  handle?: string;
}

export interface InlineActionData {
  id: string;
  label: string;
}

export interface GitWorkData {
  branch?: string;
  worktreePath?: string;
  worktreeExists?: boolean;
}

export interface ItemCardData {
  id: string;
  title: string;
  badges: BadgeData[];
  url?: string;
  /** Compact repo/source label rendered as a subtle annotation below the title (e.g. "owner/repo"). */
  repoAnnotation?: string;
  author?: ItemAuthorData;
  authored?: boolean;
  tierType: 'incoming' | 'inProgress' | 'readyToStart' | 'paused' | 'done';
  isUnseen?: boolean;
  isUrgent?: boolean;
  isSelected?: boolean;
  hasRelatedItems?: boolean;
  gitWork?: GitWorkData;
  providerId?: string;
  externalId?: string;
}

export interface BadgeData {
  label: string;
  type: 'provider' | 'type' | 'state' | 'ci' | 'provider-supplied';
  variant: string;
}

export interface CIBadgeChangeData {
  url: string;
  badge: BadgeData | null;
}

export interface EditorCIWatchData {
  state: 'open' | 'merged' | 'closed';
  runs: Array<{
    id: string;
    name: string;
    state: 'queued' | 'in_progress' | 'completed';
    conclusion?: RunConclusion;
    hasWarning?: boolean;
  }>;
  totalActive: number;
  totalFailing: number;
}

/** A single activity log entry as serialised for the editor webview. */
export interface EditorActivityLogEntry {
  timestamp: number;
  type: string;
  /** Raw `detail` string written by the producer. */
  detail?: string;
  /**
   * Pre-rendered display representation produced by an
   * extension-registered renderer. When present, the webview renders
   * this in place of {@link detail}. Otherwise the webview falls
   * back to plain-text rendering of {@link detail}.
   */
  displayDetail?: ActivityDetailRender;
}

export interface EditorItemData {
  id: string;
  title: string;
  notes?: string;
  url?: string;
  description?: string;
  state: string;
  providerLabel?: string;
  group?: string;
  author?: ItemAuthorData;
  authored?: boolean;
  createdAt: number;
  updatedAt: number;
  badges: BadgeData[];
  isProviderManaged: boolean;
  validTransitions: string[];
  hasActions: boolean;
  inlineActions?: InlineActionData[];
  activityLog: EditorActivityLogEntry[];
  relatedItems: ResolvedRelatedItem[];
  ciWatch?: EditorCIWatchData;
  gitWork?: GitWorkData;
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
  url?: string;
  hasRelatedItems?: boolean;
  isAccepted: boolean;
  isDismissed: boolean;
}

export interface PRWatchData {
  id: string;
  title: string;
  repo: string;
  state: 'open' | 'merged' | 'closed';
  url?: string;
  linkedItemId?: string;
  linkedSourceProviderId?: string;
  linkedSourceExternalId?: string;
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
