/**
 * Severity levels for log messages, ordered from least to most severe.
 * Messages below the current threshold are suppressed.
 */
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

/**
 * Minimal output sink for log messages.
 * Compatible with VS Code's `OutputChannel`.
 */
export interface LogOutput {
  appendLine(value: string): void;
}

/**
 * Converts an arbitrary value to a human-readable string for log output.
 * Errors are serialized with their stack trace when available, otherwise `name: message`.
 * Other values use `JSON.stringify` when possible and fall back to `String(arg)`
 * if JSON serialization returns `undefined` or throws.
 * @param arg - The value to serialize.
 * @returns A string representation of the argument.
 */
export function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  try {
    const json = JSON.stringify(arg);
    return json === undefined ? String(arg) : json;
  } catch {
    return String(arg);
  }
}

/**
 * Structured logger with levelled convenience methods.
 */
export interface Logger {
  /** Logs a debug-level message. Suppressed unless log level is {@link LogLevel.Debug}. */
  debug(msg: string, ...args: unknown[]): void;
  /** Logs an informational message. */
  info(msg: string, ...args: unknown[]): void;
  /** Logs a warning message. */
  warn(msg: string, ...args: unknown[]): void;
  /** Logs an error message. */
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Manages a {@link Logger} instance and its output configuration.
 */
export interface LoggerService {
  /** The logger instance used to emit messages. */
  logger: Logger;
  /**
   * Initialises the logger with an output sink and an optional starting level.
   * @param output - The sink that receives formatted log lines.
   * @param level  - Initial log level (defaults to {@link LogLevel.Info}).
   */
  initLogger(output: LogOutput, level?: LogLevel): void;
  /**
   * Changes the minimum severity level at runtime.
   * @param level - The new log level threshold.
   */
  setLogLevel(level: LogLevel): void;
}

const logLevelMap: Partial<Record<string, LogLevel>> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
};

/** Map a config string (e.g. 'debug') to a LogLevel enum value, defaulting to Info. */
export function resolveLogLevel(level: string | undefined): LogLevel {
  return (level !== undefined ? logLevelMap[level] : undefined) ?? LogLevel.Info;
}

// TODO(#471): Keep this compatibility logger for external @devdocket/shared consumers until a future major version can remove it.
/**
 * Creates a new {@link LoggerService} that starts unconfigured.
 * Call {@link LoggerService.initLogger} to attach an output sink before emitting messages.
 * @returns A fresh logger service instance.
 */
export function createLoggerService(): LoggerService {
  let outputChannel: LogOutput | undefined;
  let currentLevel: LogLevel = LogLevel.Info;

  function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
    if (level < currentLevel) return;
    const timestamp = new Date().toISOString();
    const formatted = args.length > 0
      ? `[${timestamp}] ${prefix} ${message} ${args.map(a => serializeArg(a)).join(' ')}`
      : `[${timestamp}] ${prefix} ${message}`;
    outputChannel?.appendLine(formatted);
  }

  function initLogger(output: LogOutput, level?: LogLevel): void {
    outputChannel = output;
    if (level !== undefined) {
      currentLevel = level;
    }
  }

  function setLogLevel(level: LogLevel): void {
    currentLevel = level;
  }

  const logger: Logger = {
    debug: (msg: string, ...args: unknown[]) => log(LogLevel.Debug, '[DEBUG]', msg, ...args),
    info: (msg: string, ...args: unknown[]) => log(LogLevel.Info, '[INFO]', msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log(LogLevel.Warn, '[WARN]', msg, ...args),
    error: (msg: string, ...args: unknown[]) => log(LogLevel.Error, '[ERROR]', msg, ...args),
  };

  return { logger, initLogger, setLogLevel };
}
