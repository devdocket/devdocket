/**
 * Shared types and utilities used across all DevDocket packages.
 * @module @devdocket/shared
 */
import type { ProviderItem as BaseProviderItem } from './baseProvider';

export { createLoggerService, LogLevel, resolveLogLevel, serializeArg } from './logger';
export type { Logger, LogOutput, LoggerService } from './logger';
export { BaseProvider } from './baseProvider';
export type { ProviderItem, Disposable, Event, EventEmitterLike, ProviderBadge, RelatedItemRef, ResolvedItem } from './baseProvider';
/** @deprecated Use ProviderItem instead. */
export type DiscoveredItem = BaseProviderItem;
export { isValidUrlSegment, isValidGitHubRepo, isValidRepoSlug, sanitizeUrlSegment, safeDecodeComponent } from './urlValidation';
export { validateRefreshInterval } from './refreshInterval';
export type { DevDocketRunWatcher, RunIdentifier, RunStatus, JobStatus, RunState, RunConclusion, CancellationTokenLike } from './runWatcher';
export type { DevDocketPRWatcher, PRIdentifier, PRState, PRRunsSnapshot } from './prWatcher';
export { combineSignals, createAbortError } from './signalUtils';
export { runWorkerPool, runWorkerPoolSettled } from './concurrency';
export { WorkItemState } from './workItem';
export type { WorkItem, WorkItemInput, ActivityLogEntry, ActivityType } from './workItem';
export type { DevDocketProvider, DevDocketAction, DevDocketApi, StateTransitionEvent } from './apiTypes';
