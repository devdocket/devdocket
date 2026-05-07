import type { RelatedItemRef } from '../api/types';

export interface ResolvedRelatedItem {
  /** The WorkItem id, or an opaque Sources id; use targetProviderId/targetExternalId for Sources routing. */
  targetItemId: string;
  /** Human-readable title of the target item (work item title, or discovered item title). */
  targetTitle: string;
  /** Provider's externalId for the target (e.g. "owner/repo#123"). Used for the secondary annotation. */
  targetExternalId: string;
  label: string;
  targetKind: 'workItem' | 'sources';
  targetProviderId?: string;
  relation: RelatedItemRef['relation'];
  itemType: RelatedItemRef['itemType'];
}
