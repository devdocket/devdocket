import { WorkCenterApi, WorkCenterProvider, WorkCenterAction, Disposable } from './types';
import { ProviderRegistry } from '../services/providerRegistry';
import { ActionRegistry } from '../services/actionRegistry';

export class WorkCenterApiImpl implements WorkCenterApi {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly actionRegistry: ActionRegistry,
  ) {}

  registerProvider(provider: WorkCenterProvider): Disposable {
    return this.providerRegistry.register(provider);
  }

  registerAction(action: WorkCenterAction): Disposable {
    return this.actionRegistry.register(action);
  }
}
