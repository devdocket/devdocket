import { DevDocketApi, DevDocketProvider, DevDocketAction, DevDocketRunWatcher, DevDocketPRWatcher, Disposable, type ActivityType, type ActivityDetailRenderer, type StateTransitionEvent, type GitWorkResolver } from './types';
import type { Event } from '@devdocket/shared';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import { WatcherRegistry } from '../services/watcherRegistry';
import { PRWatcherRegistry } from '../services/prWatcherRegistry';
import { ActivityDetailRendererRegistry } from '../services/activityDetailRendererRegistry';
import { GitWorkResolverRegistry } from '../services/gitWorkResolverRegistry';
import { WorkGraph } from '../services/workGraph';

export class DevDocketApiImpl implements DevDocketApi {
  readonly onDidTransitionState: Event<StateTransitionEvent>;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
    private readonly watcherRegistry: WatcherRegistry,
    private readonly prWatcherRegistry: PRWatcherRegistry,
    private readonly workGraph: WorkGraph,
    private readonly activityDetailRendererRegistry: ActivityDetailRendererRegistry,
    private readonly gitWorkResolverRegistry: GitWorkResolverRegistry,
  ) {
    this.onDidTransitionState = workGraph.onDidTransitionState;
  }

  registerProvider(provider: DevDocketProvider): Disposable {
    return this.providerRegistry.register(provider);
  }

  registerAction(action: DevDocketAction): Disposable {
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

  registerGitWorkResolver(resolver: GitWorkResolver): Disposable {
    return this.gitWorkResolverRegistry.register(resolver);
  }
}
