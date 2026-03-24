export enum WorkItemState {
  New = 'New',
  Triaged = 'Triaged',
  InProgress = 'InProgress',
  Blocked = 'Blocked',
  WaitingOn = 'WaitingOn',
  Done = 'Done',
  Archived = 'Archived',
}

export interface WorkItem {
  id: string;
  title: string;
  description?: string;
  state: WorkItemState;
  providerId?: string;
  externalId?: string;
  url?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemInput {
  title: string;
  description?: string;
}
