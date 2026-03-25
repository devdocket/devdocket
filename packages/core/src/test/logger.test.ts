import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLogger, setLogLevel, logger, LogLevel } from '../services/logger';

function createMockChannel() {
  return {
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    name: 'WorkCenter',
    replace: vi.fn(),
  };
}

describe('logger', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    channel = createMockChannel();
    initLogger(channel as any, LogLevel.Debug);
  });

  it('should write info messages to the output channel', () => {
    logger.info('test message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[INFO]');
    expect(line).toContain('test message');
  });

  it('should write debug messages when level is Debug', () => {
    logger.debug('debug message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[DEBUG]');
    expect(line).toContain('debug message');
  });

  it('should write warn messages', () => {
    logger.warn('warn message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[WARN]');
    expect(line).toContain('warn message');
  });

  it('should write error messages', () => {
    logger.error('error message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[ERROR]');
    expect(line).toContain('error message');
  });

  it('should suppress messages below the current log level', () => {
    setLogLevel(LogLevel.Warn);
    logger.debug('hidden debug');
    logger.info('hidden info');
    expect(channel.appendLine).not.toHaveBeenCalled();

    logger.warn('visible warn');
    logger.error('visible error');
    expect(channel.appendLine).toHaveBeenCalledTimes(2);
  });

  it('should include a timestamp in the formatted output', () => {
    logger.info('timestamped');
    const line = channel.appendLine.mock.calls[0][0] as string;
    // ISO timestamp pattern: YYYY-MM-DDTHH:MM:SS
    expect(line).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should format extra arguments as JSON', () => {
    logger.info('with args', { key: 'value' }, 42);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('{"key":"value"}');
    expect(line).toContain('42');
  });

  it('should respect setLogLevel changes', () => {
    setLogLevel(LogLevel.Error);
    logger.info('should not appear');
    expect(channel.appendLine).not.toHaveBeenCalled();

    logger.error('should appear');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
  });

  it('should not include extra args section when none provided', () => {
    logger.info('no args');
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toMatch(/\[INFO\] no args$/);
  });
});
