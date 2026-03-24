import { WorkItem } from '../models/workItem';

export interface ITaskStore {
  loadAll(): Promise<WorkItem[]>;
  save(item: WorkItem): Promise<void>;
  delete(id: string): Promise<void>;
}
