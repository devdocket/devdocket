import type { DiscoveredItem } from '../api/types';
import type { BadgeData } from './mainTypes';

/**
 * Single source of truth for translating provider/discovered-item metadata into
 * the structured badges shown in both the sidebar item cards and the editor
 * header. Centralized here so the two views never drift apart on labels,
 * variants, or recognized state strings.
 */

export function buildProviderBadge(providerId?: string): BadgeData | undefined {
  if (!providerId) {
    return undefined;
  }

  const normalizedProviderId = providerId.toLowerCase();
  if (normalizedProviderId.includes('github')) {
    return { label: 'GitHub', type: 'provider', variant: 'github' };
  }
  if (normalizedProviderId.includes('ado')) {
    return { label: 'ADO', type: 'provider', variant: 'ado' };
  }

  return { label: 'Manual', type: 'provider', variant: 'manual' };
}

/**
 * Build a "type" badge (Issue / PR) from the provider-supplied
 * {@link DiscoveredItem.itemType} value. Returns undefined for items where the
 * provider didn't classify the type (e.g. manual items).
 */
export function buildTypeBadge(discoveredItem?: DiscoveredItem): BadgeData | undefined {
  if (!discoveredItem?.itemType) return undefined;
  switch (discoveredItem.itemType) {
    case 'pr':
      return { label: 'PR', type: 'type', variant: 'pr' };
    case 'issue':
      return { label: 'Issue', type: 'type', variant: 'issue' };
    default:
      return undefined;
  }
}

export function buildStateBadge(discoveredItem?: DiscoveredItem): BadgeData | undefined {
  if (!discoveredItem) {
    return undefined;
  }

  const normalizedReason = normalizeText(discoveredItem.reason);
  if (normalizedReason === 'review requested') {
    return { label: 'Review requested', type: 'state', variant: 'review-requested' };
  }

  const normalizedState = normalizeText(discoveredItem.state);
  switch (normalizedState) {
    case 'changes requested':
      return { label: 'Changes requested', type: 'state', variant: 'changes-requested' };
    case 'approved':
      return { label: 'Approved', type: 'state', variant: 'approved' };
    case 'draft':
      return { label: 'Draft', type: 'state', variant: 'draft' };
    case 'ready to merge':
      return { label: 'Ready to merge', type: 'state', variant: 'ready-to-merge' };
    case 'closed':
      return { label: 'Closed', type: 'state', variant: 'closed' };
    case 'merged':
      return { label: 'Merged', type: 'state', variant: 'closed' };
    case 'active':
    case 'open':
      return { label: 'Open', type: 'state', variant: 'open' };
    case 'review received':
      return { label: 'Review received', type: 'state', variant: 'open' };
    case 'waiting on reviews':
      return { label: 'Waiting on reviews', type: 'state', variant: 'open' };
    default:
      return undefined;
  }
}

/**
 * Returns the raw `discoveredItem.state` if it does NOT correspond to a
 * recognized {@link buildStateBadge} case — so callers can render a fallback
 * pill for unknown states (e.g. ADO custom workflow states like "In Code
 * Review") without duplicating the semantic state pills already rendered for
 * known states.
 */
export function getUnrecognizedProviderState(discoveredItem?: DiscoveredItem): string | undefined {
  if (!discoveredItem) return undefined;
  const trimmed = discoveredItem.state?.trim();
  if (!trimmed) return undefined;
  if (buildStateBadge(discoveredItem)) return undefined;
  return trimmed;
}

/**
 * Build a "reason" badge from {@link DiscoveredItem.reason} that explains why
 * an item was surfaced (e.g. "mentioned"). Currently only handles values that
 * the buildStateBadge function doesn't already cover. Intended for use only
 * on incoming items — once a user accepts the item, this contextual signal
 * is no longer relevant.
 */
export function buildReasonBadge(discoveredItem?: DiscoveredItem): BadgeData | undefined {
  const normalizedReason = normalizeText(discoveredItem?.reason);
  switch (normalizedReason) {
    case 'mentioned':
      return { label: 'Mentioned', type: 'state', variant: 'review-requested' };
    case 'assigned':
      return { label: 'Assigned', type: 'state', variant: 'review-requested' };
    default:
      return undefined;
  }
}

/** Build provider + type + state badges in canonical order. CI badges are not handled here. */
export function buildBadges(providerId?: string, discoveredItem?: DiscoveredItem): BadgeData[] {
  const badges: BadgeData[] = [];
  const providerBadge = buildProviderBadge(providerId);
  if (providerBadge) {
    badges.push(providerBadge);
  }
  const typeBadge = buildTypeBadge(discoveredItem);
  if (typeBadge) {
    badges.push(typeBadge);
  }
  const stateBadge = buildStateBadge(discoveredItem);
  if (stateBadge) {
    badges.push(stateBadge);
  }
  return badges;
}

function normalizeText(value?: string): string | undefined {
  return value?.trim().toLowerCase().replace(/[_-]+/g, ' ');
}
