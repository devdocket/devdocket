import { DevDocketApi, DevDocketProvider, DevDocketAction, DevDocketRunWatcher, DevDocketPRWatcher, Disposable, type ActivityType, type ActivityDetailRenderer, type StateTransitionEvent } from './types';
import { CONTRACT_VERSION, compareContractVersions, isContractVersionSatisfied } from './types';
import type { Event } from '@devdocket/shared';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { ActivityDetailRendererRegistry } from '../services/activityDetailRendererRegistry';
import { WorkGraph } from '../services/workGraph';
import { logger } from '../services/logger';

const NOOP_DISPOSABLE: Disposable = { dispose: () => { /* no-op */ } };

function isMalformedMinContractVersion(value: string, current: string): boolean {
  // An empty or whitespace-only declaration is treated as malformed so it
  // surfaces a warning rather than silently bypassing the gate.
  if (value.trim() === '') {
    return true;
  }
  // compareContractVersions returns NaN when either input is unparseable.
  // The core's `current` is always valid (it's our own constant), so a NaN
  // result here unambiguously means `value` failed to parse.
  return Number.isNaN(compareContractVersions(current, value));
}

export class DevDocketApiImpl implements DevDocketApi {
  readonly contractVersion: string = CONTRACT_VERSION;
  readonly onDidTransitionState: Event<StateTransitionEvent>;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
    private readonly watcherRegistry: WatcherRegistry,
    private readonly prWatcherRegistry: PRWatcherRegistry,
    private readonly workGraph: WorkGraph,
    private readonly activityDetailRendererRegistry: ActivityDetailRendererRegistry,
  ) {
    this.onDidTransitionState = workGraph.onDidTransitionState;
  }

  registerProvider(provider: DevDocketProvider): Disposable {
    const min = provider.minContractVersion;
    if (min !== undefined) {
      if (isMalformedMinContractVersion(min, this.contractVersion)) {
        logger.warn(
          `Provider "${provider.id}" declared minContractVersion="${min}", which is not a valid semver ` +
          `major.minor.patch string. Ignoring the compatibility gate and proceeding with registration; ` +
          `fix the provider's minContractVersion declaration.`,
        );
      } else if (!isContractVersionSatisfied(this.contractVersion, min)) {
        logger.warn(
          `Provider "${provider.id}" requires DevDocket API contract version >= ${min}, ` +
          `but core implements ${this.contractVersion}. Skipping registration; ` +
          `update the DevDocket core extension to enable this provider.`,
        );
        return NOOP_DISPOSABLE;
      }
    }
    return this.providerRegistry.register(provider);
  }

  registerAction(action: DevDocketAction): Disposable {
    const min = action.minContractVersion;
    if (min) {
      if (isMalformedMinContractVersion(min, this.contractVersion)) {
        logger.warn(
          `Action "${action.id}" declared minContractVersion="${min}", which is not a valid semver ` +
          `major.minor.patch string. Ignoring the compatibility gate and proceeding with registration; ` +
          `fix the action's minContractVersion declaration.`,
        );
      } else if (!isContractVersionSatisfied(this.contractVersion, min)) {
        logger.warn(
          `Action "${action.id}" requires DevDocket API contract version >= ${min}, ` +
          `but core implements ${this.contractVersion}. Skipping registration; ` +
          `update the DevDocket core extension to enable this action.`,
        );
        return NOOP_DISPOSABLE;
      }
    }
    return this.actionRegistry.register(action);
  }

  getProviderItem(providerId: string, externalId: string) {
    return this.providerRegistry.findProviderItem(providerId, externalId);
  }

  registerRunWatcher(watcher: DevDocketRunWatcher): Disposable {
    return this.watcherRegistry.register(watcher);
  }

  registerPRWatcher(watcher: DevDocketPRWatcher): Disposable {
    return this.prWatcherRegistry.register(watcher);
  }

  async addActivity(itemId: string, type: ActivityType, detail?: string): Promise<void> {
    return this.workGraph.addActivity(itemId, type, detail);
  }

  registerActivityDetailRenderer(type: ActivityType, render: ActivityDetailRenderer): Disposable {
    return this.activityDetailRendererRegistry.register(type, render);
  }
}
