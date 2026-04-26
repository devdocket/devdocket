import { WorkGraph } from './workGraph';
import { ProviderRegistry } from './providerRegistry';
import { logger } from './logger';

/**
 * Synchronize provider-discovered descriptions with persisted WorkItem descriptions.
 *
 * Called after a provider refresh, this function iterates the provider's
 * discovered items and updates any WorkItems whose persisted description differs
 * from the live provider description. Unlike title sync, empty/cleared
 * descriptions are propagated (if a provider clears the description, the
 * persisted value should reflect that).
 */
export async function syncProviderDescriptions(
  providerRegistry: ProviderRegistry,
  workGraph: WorkGraph,
): Promise<void> {
  for (const [providerId, discoveredItems] of providerRegistry.getAllDiscoveredItems()) {
    for (const discovered of discoveredItems) {
      const workItem = workGraph.findItemByProvenance(providerId, discovered.externalId);
      if (workItem && workItem.description !== discovered.description) {
        try {
          await workGraph.updateItem(workItem.id, { description: discovered.description });
          logger.debug(`Synced description for ${providerId}/${discovered.externalId}`);
        } catch (err) {
          logger.error(`Failed to sync description for ${providerId}/${discovered.externalId}`, err);
        }
      }
    }
  }
}
