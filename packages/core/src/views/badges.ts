import type { ProviderItem, ProviderBadge } from '../api/types';
import type { BadgeData } from './mainTypes';

/**
 * Single source of truth for translating provider/discovered-item metadata into
 * the structured badges shown in both the sidebar item cards and the editor
 * header. Centralized here so the two views never drift apart.
 *
 * The core only owns three badge categories:
 *   1. Provider (GitHub / ADO / Manual) — derived from providerId
 *   2. Type     (Issue / PR)            — derived from item.itemType
 *   3. CI       (passed / failed / etc) — derived from the watcher service
 *
 * Everything else — state, reason, custom workflow names — is the provider's
 * responsibility, declared via {@link ProviderItem.badges}. Core renders
 * exactly what the provider gives it, no inference from raw `state`/`reason`
 * strings.
 */

/**
 * Build the provider badge for an item.
 *
 * - Items with no providerId are manual ("Manual").
 * - GitHub and ADO providers get their canonical short labels and themed
 *   colors so they're instantly recognizable.
 * - Other (third-party) providers fall back to the human-readable label
 *   passed in by the caller — typically `providerRegistry.getProviderLabel()`
 *   — or the providerId itself if no label is available. This avoids
 *   mislabeling third-party providers as "Manual".
 */
export function buildProviderBadge(providerId?: string, label?: string): BadgeData | undefined {
  if (!providerId) {
    return { label: 'Manual', type: 'provider', variant: 'manual' };
  }

  const normalizedProviderId = providerId.toLowerCase();
  // Match either the bare provider id or one of its sub-provider ids (e.g.
  // 'github', 'github-pr-reviews', 'github-mentions'). Substring matching
  // would mis-classify third-party providers like 'my-github-mirror' or
  // 'azure-shadow' as the canonical GitHub / ADO providers.
  if (normalizedProviderId === 'github' || normalizedProviderId.startsWith('github-')) {
    return { label: 'GitHub', type: 'provider', variant: 'github' };
  }
  if (normalizedProviderId === 'ado' || normalizedProviderId.startsWith('ado-')) {
    return { label: 'ADO', type: 'provider', variant: 'ado' };
  }

  // Unknown / third-party provider — show the real label so the user
  // can tell what surfaced this item. BadgePill's getBadgeColors falls
  // back to the default VS Code badge style for unrecognized variants.
  return { label: label ?? providerId, type: 'provider', variant: 'other' };
}

/**
 * Build a "type" badge (Issue / PR) from the provider-supplied
 * {@link ProviderItem.itemType} value. Returns undefined for items where the
 * provider didn't classify the type (e.g. manual items).
 */
export function buildTypeBadge(providerItem?: ProviderItem): BadgeData | undefined {
  if (!providerItem?.itemType) return undefined;
  switch (providerItem.itemType) {
    case 'pr':
      return { label: 'PR', type: 'type', variant: 'pr' };
    case 'issue':
      return { label: 'Issue', type: 'type', variant: 'issue' };
    default:
      return undefined;
  }
}

/**
 * Map provider-declared {@link ProviderBadge} entries into the renderable
 * {@link BadgeData} shape, filtered to a target view. Providers control the
 * label and severity; core picks the actual colors via {@link variantToColorKey}.
 */
export function buildProviderBadges(
  providerItem: ProviderItem | undefined,
  view: 'sidebar' | 'editor',
): BadgeData[] {
  if (!providerItem?.badges?.length) return [];
  return providerItem.badges
    .filter(badge => (badge.show ?? 'both') === 'both' || badge.show === view)
    .map(badge => ({
      label: badge.label,
      type: 'provider-supplied',
      variant: variantToColorKey(badge.variant),
    }));
}

/**
 * Map a {@link ProviderBadge.variant} severity hint to the corresponding key
 * in the existing color palette so the new "provider-supplied" badge type
 * reuses the same theme-aware colors that previously powered semantic state
 * badges.
 */
function variantToColorKey(variant: ProviderBadge['variant']): string {
  switch (variant) {
    case 'info':    return 'open';              // blue
    case 'success': return 'approved';          // green
    case 'warning': return 'review-requested';  // amber
    case 'danger':  return 'changes-requested'; // red
    case 'neutral':
    default:        return 'neutral';           // outline-only (handled in BadgePill)
  }
}
