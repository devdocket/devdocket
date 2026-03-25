import * as vscode from 'vscode';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

let outputChannel: vscode.OutputChannel | undefined;
let currentLevel: LogLevel = LogLevel.Info;

export function initLogger(channel: vscode.OutputChannel, level?: LogLevel): void {
  outputChannel = channel;
  if (level !== undefined) {
    currentLevel = level;
  }
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  if (level < currentLevel) return;
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${prefix} ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${prefix} ${message}`;
  outputChannel?.appendLine(formatted);
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log(LogLevel.Debug, '[DEBUG]', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log(LogLevel.Info, '[INFO]', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log(LogLevel.Warn, '[WARN]', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log(LogLevel.Error, '[ERROR]', msg, ...args),
};
