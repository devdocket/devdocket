// Canonical type declarations live in @devdocket/shared; re-export for
// existing intra-core imports (e.g. `from '../api/types'`).
export type { Disposable, Event, ProviderItem, ProviderItemAuthor, ProviderItemCapabilities, GitWorkInfo, ProviderBadge, RelatedItemRef, ResolvedUrlResult, DevDocketRunWatcher, DevDocketPRWatcher } from '@devdocket/shared';
export type { ActivityLogEntry, ActivityType } from '@devdocket/shared';
export type { StateTransitionEvent, ProviderRefreshOptions, ResolveUrlOptions, DevDocketProvider, DevDocketAction, DevDocketActionPresentation, DevDocketApi, ActivityDetailRender, ActivityDetailRenderer } from '@devdocket/shared';
