import type { RelatedItemRef } from '../api/types';

export interface ResolvedRelatedItem {
  /** The work item id, or `${providerId}::${externalId}` for Sources entries. */
  targetItemId: string;
  label: string;
  targetKind: 'workItem' | 'sources';
  relation: RelatedItemRef['relation'];
  itemType: RelatedItemRef['itemType'];
}
