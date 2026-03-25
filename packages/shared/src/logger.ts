export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

export interface LogOutput {
  appendLine(value: string): void;
}

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

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface LoggerService {
  logger: Logger;
  initLogger(output: LogOutput, level?: LogLevel): void;
  setLogLevel(level: LogLevel): void;
}

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
