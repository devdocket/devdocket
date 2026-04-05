export enum WorkItemState {
  New = 'New',
  Triaged = 'Triaged',
  InProgress = 'InProgress',
  Paused = 'Paused',
  Done = 'Done',
  Archived = 'Archived',
}

export interface WorkItem {
  id: string;
  title: string;
  notes?: string;
  state: WorkItemState;
  providerId?: string;
  externalId?: string;
  url?: string;
  sortOrder?: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemInput {
  title: string;
  notes?: string;
}
