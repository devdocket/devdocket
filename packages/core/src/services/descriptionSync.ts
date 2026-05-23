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
  providerId: string,
  providerRegistry: ProviderRegistry,
  workGraph: WorkGraph,
): Promise<void> {
  const providerItems = providerRegistry.getAllProviderItems().get(providerId);
  if (!providerItems) {
    return;
  }
  for (const discovered of providerItems) {
    const workItem = workGraph.findItemByProvenance(providerId, discovered.externalId);
    if (workItem && 'description' in discovered && workItem.description !== discovered.description) {
      try {
        await workGraph.updateItem(workItem.id, { description: discovered.description }, { source: 'provider-sync' });
        logger.debug(`Synced description for ${providerId}/${discovered.externalId}`);
      } catch (err) {
        logger.error(`Failed to sync description for ${providerId}/${discovered.externalId}`, err);
      }
    }
  }
}
