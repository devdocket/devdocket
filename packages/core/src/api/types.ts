import { WorkItem } from '../models/workItem';

export interface Disposable {
  dispose(): void;
}

export interface Event<T> {
  (listener: (e: T) => void): Disposable;
}

export interface DiscoveredItem {
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
  reason?: string;
}

export interface WorkCenterProvider {
  readonly id: string;
  readonly label: string;
  readonly resurfaceDismissed?: boolean;
  readonly onDidDiscoverItems: Event<DiscoveredItem[]>;
  refresh(): Promise<void>;
}

export interface WorkCenterAction {
  readonly id: string;
  readonly label: string;
  canRun(item: WorkItem): boolean;
  run(item: WorkItem): Promise<void>;
}

export interface WorkCenterApi {
  registerProvider(provider: WorkCenterProvider): Disposable;
  registerAction(action: WorkCenterAction): Disposable;
}
