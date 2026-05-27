/**
 * Shared types and utilities used across all DevDocket packages.
 * @module @devdocket/shared
 */
export { createLoggerService, LogLevel, resolveLogLevel, serializeArg } from './logger';
export type { Logger, LogOutput, LoggerService } from './logger';
export { BaseProvider } from './baseProvider';
export type { ProviderItem, ProviderItemAuthor, ProviderItemCapabilities, Disposable, Event, EventEmitterLike, GitWorkInfo, ProviderBadge, RelatedItemRef, ResolvedUrlResult, WindowStateProvider } from './baseProvider';
export { BackoffPolicy, parseRateLimitResetHeader, parseRetryAfterHeader } from './backoffPolicy';
export type { BackoffApplyOptions, BackoffPolicyOptions, BackoffStateSnapshot } from './backoffPolicy';
export { PollingBackoffError, isPollingBackoffError } from './pollingErrors';
export type { PollingBackoffErrorOptions } from './pollingErrors';
export { isSafeUrl, isValidUrlSegment, isValidGitHubRepo, isValidRepoSlug, sanitizeUrlSegment, safeDecodeComponent } from './urlValidation';
export type { RecoverableError, RecoverableErrorAction } from './recoverableError';
export { isRecoverableError } from './recoverableError';
export { validateRefreshInterval } from './refreshInterval';
export type { DevDocketRunWatcher, RunIdentifier, RunStatus, JobStatus, RunState, RunConclusion, CancellationTokenLike } from './runWatcher';
export type { DevDocketPRWatcher, PRIdentifier, PRState, PRRunsSnapshot } from './prWatcher';
export { abortFromToken, combineSignals, createAbortError, raceWithAbort, getSessionWithAuthFallback } from './signalUtils';
export { runWorkerPool, runWorkerPoolSettled } from './concurrency';
export { WorkItemState } from './workItem';
export type { WorkItem, WorkItemInput, ActivityLogEntry, ActivityType } from './workItem';
export type { DevDocketProvider, DevDocketAction, DevDocketActionPresentation, DevDocketApi, StateTransitionEvent, ProviderRefreshOptions, ResolveUrlOptions, ActivityDetailRender, ActivityDetailRenderer } from './apiTypes';
