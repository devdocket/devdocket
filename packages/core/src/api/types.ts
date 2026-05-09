import type { ProviderItem as SharedProviderItem } from '@devdocket/shared';

// Canonical type declarations live in @devdocket/shared; re-export for
// existing intra-core imports (e.g. `from '../api/types'`).
export type { Disposable, Event, ProviderItem, ProviderBadge, RelatedItemRef, ResolvedItem, DevDocketRunWatcher, DevDocketPRWatcher } from '@devdocket/shared';
export type { ActivityLogEntry, ActivityType } from '@devdocket/shared';
export type { StateTransitionEvent, DevDocketProvider, DevDocketAction, DevDocketApi } from '@devdocket/shared';

/** @deprecated Use ProviderItem instead. */
export type DiscoveredItem = SharedProviderItem;
