import { WorkItem } from '../models/workItem';
import type { Disposable, WorkCenterProvider } from '@workcenter/shared';

export type { Disposable, Event, DiscoveredItem, WorkCenterProvider } from '@workcenter/shared';

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
