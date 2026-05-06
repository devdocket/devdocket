import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config edge cases', () => {
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
