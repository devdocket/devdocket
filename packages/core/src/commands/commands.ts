import * as vscode from 'vscode';
import { WorkGraph } from '../services/workGraph';
import { ActionRegistry } from '../services/actionRegistry';
import { ProviderRegistry } from '../services/providerRegistry';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';
import type { ProviderLabelCache } from '../storage/providerLabelCache';
import type { ViewRevealer } from '../services/viewRevealer';
import { WatcherService } from '../services/watcherService';
import { WatcherRegistry } from '../services/watcherRegistry';
import { registerInboxCommands } from './inboxCommands';
import { registerQueueCommands } from './queueCommands';
import { registerFocusCommands } from './focusCommands';
import { registerHistoryCommands } from './historyCommands';
import { registerLayoutCommands } from './layoutCommands';
import { registerGeneralCommands } from './generalCommands';
import { registerSourcesCommands } from './sourcesCommands';
import { registerWatchCommands } from './watchCommands';

export function registerCommands(
  context: vscode.ExtensionContext,
  workGraph: WorkGraph,
  actionRegistry: ActionRegistry,
  stateStore: DiscoveredStateStore,
  providerRegistry: ProviderRegistry,
  labelCache: ProviderLabelCache,
  watcherRegistry: WatcherRegistry,
  watcherService: WatcherService,
  revealer?: ViewRevealer,
): void {
  registerInboxCommands(context, workGraph, stateStore, revealer);
  registerQueueCommands(context, workGraph, revealer);
  registerFocusCommands(context, workGraph, revealer);
  registerHistoryCommands(context, workGraph, revealer);
  registerLayoutCommands(context);
  registerGeneralCommands(context, workGraph, actionRegistry, providerRegistry, labelCache, revealer);
  registerSourcesCommands(context, workGraph, stateStore, revealer);
  registerWatchCommands(context, watcherRegistry, watcherService);
}
