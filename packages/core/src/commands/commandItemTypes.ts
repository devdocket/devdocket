export interface InboxItem {
  kind: 'item';
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  group?: string;
  canonicalId?: string;
}

export interface InboxProviderNode {
  kind: 'provider';
  providerId: string;
  label: string;
}

export interface InboxGroupNode {
  kind: 'group';
  providerId: string;
  groupName: string;
  unseenCount: number;
}

export type InboxElement = InboxItem | InboxProviderNode | InboxGroupNode;

export interface SourceItemNode {
  kind: 'item';
  providerId: string;
  externalId: string;
  title: string;
  description?: string;
  itemType?: 'issue' | 'pr';
  url?: string;
  group?: string;
}

export interface SourceProviderNode {
  kind: 'provider';
  providerId: string;
  label: string;
}

export interface SourceGroupNode {
  kind: 'group';
  providerId: string;
  groupName: string;
}

export type SourcesElement = SourceItemNode | SourceProviderNode | SourceGroupNode;
