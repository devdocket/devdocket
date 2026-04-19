import { DevDocketApi, DevDocketProvider, DevDocketAction, Disposable, type ActivityType } from './types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';
import { WorkGraph } from '../services/workGraph';

export class DevDocketApiImpl implements DevDocketApi {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
    private readonly workGraph: WorkGraph,
  ) {}

  registerProvider(provider: DevDocketProvider): Disposable {
    return this.providerRegistry.register(provider);
  }

  registerAction(action: DevDocketAction): Disposable {
    return this.actionRegistry.register(action);
  }

  async addActivity(itemId: string, type: ActivityType, detail?: string): Promise<void> {
    return this.workGraph.addActivity(itemId, type, detail);
  }
}
