import { DevDocketApi, DevDocketProvider, DevDocketAction, DevDocketRunWatcher, Disposable, type ActivityType } from './types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import { WatcherRegistry } from '../services/watcherRegistry';
import { WorkGraph } from '../services/workGraph';

export class DevDocketApiImpl implements DevDocketApi {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
    private readonly watcherRegistry: WatcherRegistry,
    private readonly workGraph: WorkGraph,
  ) {}

  registerProvider(provider: DevDocketProvider): Disposable {
    return this.providerRegistry.register(provider);
  }

  registerAction(action: DevDocketAction): Disposable {
    return this.actionRegistry.register(action);
  }

  registerRunWatcher(watcher: DevDocketRunWatcher): Disposable {
    return this.watcherRegistry.register(watcher);
  }

  async addActivity(itemId: string, type: ActivityType, detail?: string): Promise<void> {
    return this.workGraph.addActivity(itemId, type, detail);
  }
}
