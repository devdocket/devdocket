import { DevDocketApi, DevDocketProvider, DevDocketAction, Disposable } from './types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';

export class DevDocketApiImpl implements DevDocketApi {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
  ) {}

  registerProvider(provider: DevDocketProvider): Disposable {
    return this.providerRegistry.register(provider);
  }

  registerAction(action: DevDocketAction): Disposable {
    return this.actionRegistry.register(action);
  }
}
