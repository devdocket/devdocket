import type { ProviderItem } from '../api/types';
import type { ProviderHealthStatus } from '../services/providerRegistry';
import type { RelatedItemsIndex } from '../services/relatedItems';
import type { CIBadgeLookup } from './ciBadgeLookup';
import type { SourceGroupData, SourceItemData, SourceProviderData } from './mainTypes';
import { getProviderItemKey } from './providerItemKey';
import { buildSidebarBadges, hasResolvedRelatedItems } from './tierSnapshotBuilder';

export interface SourcesSnapshotBuilderOptions {
  allProviderItems: ReadonlyMap<string, readonly ProviderItem[]>;
  getInboxState(providerId: string, externalId: string): string | undefined;
  getProviderLabel(providerId: string): string;
  getProviderHealth(providerId: string): Pick<ProviderHealthStatus, 'status'>;
  relatedItemsIndex: RelatedItemsIndex;
  ciBadgeLookup: CIBadgeLookup;
}

export function buildSourcesData(options: SourcesSnapshotBuilderOptions): SourceProviderData[] {
  return Array.from(options.allProviderItems)
    .map(([providerId, items]) => {
      const groups = new Map<string, SourceItemData[]>();

      for (const item of items) {
        const groupName = item.group?.trim() || 'Ungrouped';
        const state = options.getInboxState(providerId, item.externalId);
        const groupItems = groups.get(groupName) ?? [];
        groupItems.push({
          externalId: item.externalId,
          providerId,
          title: item.title,
          badges: buildSidebarBadges(
            providerId,
            item,
            options.ciBadgeLookup.byProviderItemKey.get(getProviderItemKey(providerId, item.externalId)),
            options.getProviderLabel,
          ),
          url: item.url,
          hasRelatedItems: hasResolvedRelatedItems(providerId, item.externalId, options.relatedItemsIndex),
          isAccepted: state === 'accepted',
          isDismissed: state === 'dismissed',
        });
        groups.set(groupName, groupItems);
      }

      const sortedGroups: SourceGroupData[] = Array.from(groups.entries())
        .map(([name, groupItems]) => ({
          name,
          items: groupItems.sort((a, b) => a.title.localeCompare(b.title)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        providerId,
        label: options.getProviderLabel(providerId),
        isHealthy: options.getProviderHealth(providerId).status !== 'unhealthy',
        groups: sortedGroups,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
