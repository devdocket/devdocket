type LogMethod = (message: string, ...args: unknown[]) => void;

export interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let activeLogger: Logger = noopLogger;

export const logger: Logger = {
  debug: (message: string, ...args: unknown[]) => activeLogger.debug(message, ...args),
  info: (message: string, ...args: unknown[]) => activeLogger.info(message, ...args),
  warn: (message: string, ...args: unknown[]) => activeLogger.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => activeLogger.error(message, ...args),
};

export function setLogger(log: Logger): void {
  activeLogger = log;
}
