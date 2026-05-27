import { WorkItem } from '../models/workItem';

export interface ITaskStore {
  loadAll(): Promise<WorkItem[]>;
  /** Stage a mutation in memory. If supported, call flush() to await disk durability. */
  save(item: WorkItem): Promise<void>;
  /** Stage a batch mutation in memory. If supported, call flush() to await disk durability. */
  saveAll(items: WorkItem[]): Promise<void>;
  /** Stage a deletion in memory. If supported, call flush() to await disk durability. */
  delete(id: string): Promise<void>;
  flush?(): Promise<void>;
  invalidateCache?(): void | Promise<void>;
}
