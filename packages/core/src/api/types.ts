import { WorkItem } from '../models/workItem';
import type { Disposable } from '@workcenter/shared';

export type { Disposable, Event, DiscoveredItem, WorkCenterProvider } from '@workcenter/shared';

/**
 * A context-menu action that can be run against a {@link WorkItem}.
 *
 * Actions are registered via {@link WorkCenterApi.registerAction} and surfaced
 * dynamically — {@link canRun} is called to determine visibility.
 */
export interface WorkCenterAction {
  /** Stable unique identifier for this action. */
  readonly id: string;
  /** Label shown in the context menu. */
  readonly label: string;
  /** Return `true` if this action is applicable to the given item. */
  canRun(item: WorkItem): boolean;
  /** Execute the action for the given item. */
  run(item: WorkItem): Promise<void>;
}

/**
 * Main entry point for provider extensions.
 *
 * Obtain this API from the core extension by first getting its extension
 * wrapper via `vscode.extensions.getExtension('mthalman.workcenter')`, then
 * activating it with `await extension.activate()` (or reading `extension.exports`
 * after activation). The core extension's `activate()` returns this API.
 */
export interface WorkCenterApi {
  /** Register a provider that discovers work items from an external source. */
  registerProvider(provider: WorkCenterProvider): Disposable;
  /** Register a context-menu action that operates on work items. */
  registerAction(action: WorkCenterAction): Disposable;
}
