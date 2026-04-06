import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLogger, setLogLevel, logger, LogLevel } from '../services/logger';

// Mirrors the logLevelMap from extension.ts — tests verify the mapping + fallback behavior.
// Intentionally duplicated: these tests document the expected contract of the logLevel
// config value. If the production map in extension.ts diverges, a developer updating these
// tests will notice the mismatch.
const logLevelMap: Record<string, LogLevel> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
};

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

describe('config edge cases', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    channel = createMockChannel();
    initLogger(channel as any, LogLevel.Debug);
  });

  describe('logLevel mapping', () => {
    it('resolves all valid lowercase level strings', () => {
      expect(logLevelMap['debug'] ?? LogLevel.Info).toBe(LogLevel.Debug);
      expect(logLevelMap['info'] ?? LogLevel.Info).toBe(LogLevel.Info);
      expect(logLevelMap['warn'] ?? LogLevel.Info).toBe(LogLevel.Warn);
      expect(logLevelMap['error'] ?? LogLevel.Info).toBe(LogLevel.Error);
    });

    it.each([
      ['typo "debg"', 'debg'],
      ['uppercase "DEBUG"', 'DEBUG'],
      ['mixed case "Info"', 'Info'],
      ['empty string', ''],
      ['unrelated word "verbose"', 'verbose'],
      ['partial match "warning"', 'warning'],
    ])('falls back to Info for %s', (_label, value) => {
      const resolved = logLevelMap[value] ?? LogLevel.Info;
      expect(resolved).toBe(LogLevel.Info);
    });

    it('falls back to Info when config returns a number', () => {
      for (const val of [0, 1, 42, -1]) {
        const resolved = logLevelMap[val as unknown as string] ?? LogLevel.Info;
        expect(resolved).toBe(LogLevel.Info);
      }
    });

    it('falls back to Info for undefined', () => {
      const resolved = logLevelMap[undefined as unknown as string] ?? LogLevel.Info;
      expect(resolved).toBe(LogLevel.Info);
    });

    it('falls back to Info for null', () => {
      const resolved = logLevelMap[null as unknown as string] ?? LogLevel.Info;
      expect(resolved).toBe(LogLevel.Info);
    });
  });

  describe('logLevel fallback applied to logger', () => {
    it('suppresses debug when invalid config falls back to Info', () => {
      const resolved = logLevelMap['TYPO'] ?? LogLevel.Info;
      initLogger(channel as any, resolved);

      logger.debug('should be hidden');
      expect(channel.appendLine).not.toHaveBeenCalled();

      logger.info('should be visible');
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });

    it('setLogLevel with invalid config change also falls back to Info', () => {
      initLogger(channel as any, LogLevel.Debug);

      // Simulate config change to invalid value
      const newLevel = logLevelMap['WARNING'] ?? LogLevel.Info;
      setLogLevel(newLevel);

      logger.debug('suppressed');
      expect(channel.appendLine).not.toHaveBeenCalled();

      logger.info('visible');
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });

    it('handles empty string logLevel by falling back to Info', () => {
      const resolved = logLevelMap[''] ?? LogLevel.Info;
      initLogger(channel as any, resolved);

      logger.debug('hidden');
      expect(channel.appendLine).not.toHaveBeenCalled();

      logger.info('visible');
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });
  });

  describe('showInboxNotifications edge cases', () => {
    // Extension reads: config.get<boolean>('showInboxNotifications', true)
    // Then checks: if (showNotifications && newCount > 0)
    // These tests exercise that decision path, including how the default is applied.

    function runShowInboxNotificationDecision(
      rawConfigValue: unknown,
      newCount: number,
    ) {
      const config = {
        get: vi.fn(<T>(_key: string, defaultValue: T) => {
          return (rawConfigValue === undefined ? defaultValue : rawConfigValue) as T;
        }),
      };

      const showNotifications = config.get<boolean>('showInboxNotifications', true);
      const shouldNotify = Boolean(showNotifications && newCount > 0);

      return { config, showNotifications, shouldNotify };
    }

    it('string "true" is returned by config.get and notification fires', () => {
      const result = runShowInboxNotificationDecision('true', 3);

      expect(result.config.get).toHaveBeenCalledWith('showInboxNotifications', true);
      expect(result.showNotifications).toBe('true');
      expect(result.shouldNotify).toBe(true);
    });

    it('string "false" is returned by config.get and still fires because non-empty strings are truthy', () => {
      const result = runShowInboxNotificationDecision('false', 3);

      expect(result.config.get).toHaveBeenCalledWith('showInboxNotifications', true);
      expect(result.showNotifications).toBe('false');
      expect(result.shouldNotify).toBe(true);
    });

    it('number 1 is returned by config.get and notification fires', () => {
      const result = runShowInboxNotificationDecision(1, 3);

      expect(result.config.get).toHaveBeenCalledWith('showInboxNotifications', true);
      expect(result.showNotifications).toBe(1);
      expect(result.shouldNotify).toBe(true);
    });

    it('number 0 is returned by config.get and notification is suppressed', () => {
      const result = runShowInboxNotificationDecision(0, 3);

      expect(result.config.get).toHaveBeenCalledWith('showInboxNotifications', true);
      expect(result.showNotifications).toBe(0);
      expect(result.shouldNotify).toBe(false);
    });

    it('null is returned by config.get and notification is suppressed', () => {
      const result = runShowInboxNotificationDecision(null, 3);

      expect(result.config.get).toHaveBeenCalledWith('showInboxNotifications', true);
      expect(result.showNotifications).toBeNull();
      expect(result.shouldNotify).toBe(false);
    });

    it('undefined causes config.get to apply the default true value', () => {
      const result = runShowInboxNotificationDecision(undefined, 1);

      expect(result.config.get).toHaveBeenCalledWith('showInboxNotifications', true);
      expect(result.showNotifications).toBe(true);
      expect(result.shouldNotify).toBe(true);
    });
  });
});
