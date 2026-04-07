// Re-declared to match core API contract — separate extension cannot import core types directly

export interface Disposable {
  dispose(): void;
}

export interface WorkItem {
  id: string;
  title: string;
  description?: string;
  state: 'New' | 'Triaged' | 'InProgress' | 'Paused' | 'Blocked' | 'WaitingOn' | 'Done' | 'Archived';
  providerId?: string;
  externalId?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkCenterAction {
  readonly id: string;
  readonly label: string;
  canRun(item: WorkItem): boolean;
  run(item: WorkItem): Promise<void>;
}

export interface WorkCenterProvider {
  readonly id: string;
  readonly label: string;
  readonly resurfaceDismissed?: boolean;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(token?: import('vscode').CancellationToken): Promise<void>;
}

interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

export interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
}

export interface WorkCenterApi {
  registerProvider(provider: WorkCenterProvider): Disposable;
  registerAction(action: WorkCenterAction): Disposable;
}
