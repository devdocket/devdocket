import type { RelatedItemRef } from '../api/types';

export interface ResolvedRelatedItem {
  /** The WorkItem id, or an opaque Sources id; use targetProviderId/targetExternalId for Sources routing. */
  targetItemId: string;
  label: string;
  targetKind: 'workItem' | 'sources';
  targetProviderId?: string;
  targetExternalId?: string;
  relation: RelatedItemRef['relation'];
  itemType: RelatedItemRef['itemType'];
}
