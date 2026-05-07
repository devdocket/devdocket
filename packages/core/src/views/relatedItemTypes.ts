import type { RelatedItemRef } from '../api/types';

export interface ResolvedRelatedItem {
  /** The work item id, or `${providerId}::${externalId}` for Sources entries. */
  targetItemId: string;
  label: string;
  targetKind: 'workItem' | 'sources';
  targetProviderId?: string;
  targetExternalId?: string;
  relation: RelatedItemRef['relation'];
  itemType: RelatedItemRef['itemType'];
}
