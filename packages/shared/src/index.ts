/**
 * Shared logging utilities used across all DevDocket packages.
 * @module @devdocket/shared
 */
export { createLoggerService, LogLevel, resolveLogLevel, serializeArg } from './logger';
export type { Logger, LogOutput, LoggerService } from './logger';
export { BaseProvider } from './baseProvider';
export type { DiscoveredItem, Disposable, Event, EventEmitterLike } from './baseProvider';
export { isValidUrlSegment, isValidGitHubRepo, isValidRepoSlug, sanitizeUrlSegment } from './urlValidation';
export { validateRefreshInterval } from './refreshInterval';
