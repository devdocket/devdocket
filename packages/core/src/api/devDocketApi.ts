import { DevDocketApi, DevDocketProvider, DevDocketAction, DevDocketRunWatcher, Disposable } from './types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import { WatcherRegistry } from '../services/watcherRegistry';

export class DevDocketApiImpl implements DevDocketApi {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
    private readonly watcherRegistry: WatcherRegistry,
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
}
