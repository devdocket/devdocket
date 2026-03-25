// Re-declared to match core API contract — separate extension cannot import core types directly

export interface Disposable {
  dispose(): void;
}

export interface WorkItem {
  id: string;
  title: string;
  description?: string;
  state: 'New' | 'Triaged' | 'InProgress' | 'Blocked' | 'WaitingOn' | 'Done' | 'Archived';
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

export type WorkCenterProvider = unknown;

export interface WorkCenterApi {
  registerProvider(provider: WorkCenterProvider): Disposable;
  registerAction(action: WorkCenterAction): Disposable;
}
