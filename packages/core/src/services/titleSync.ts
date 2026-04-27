import { WorkGraph } from './workGraph';
import { ProviderRegistry } from './providerRegistry';
import { logger } from './logger';

/**
 * Synchronize provider-discovered titles with persisted WorkItem titles.
 *
 * Called after a provider refresh, this function iterates the provider's
 * discovered items and updates any WorkItems whose persisted title differs
 * from the live provider title. This keeps tree views, editor panels, and
 * tooltips current without view-layer title resolution.
 *
 * Covers both provider-discovered items and manually imported/linked items
 * that share the same providerId + externalId.
 */
export async function syncProviderTitles(
  providerId: string,
  providerRegistry: ProviderRegistry,
  workGraph: WorkGraph,
): Promise<void> {
  const discoveredItems = providerRegistry.getAllDiscoveredItems().get(providerId);
  if (!discoveredItems) {
    return;
  }
  for (const discovered of discoveredItems) {
    const workItem = workGraph.findItemByProvenance(providerId, discovered.externalId);
    if (workItem && discovered.title?.trim() && workItem.title !== discovered.title) {
      try {
        await workGraph.updateItem(workItem.id, { title: discovered.title });
        logger.debug(`Synced title for ${providerId}/${discovered.externalId}: "${workItem.title}" → "${discovered.title}"`);
      } catch (err) {
        logger.error(`Failed to sync title for ${providerId}/${discovered.externalId}`, err);
      }
    }
  }
}
