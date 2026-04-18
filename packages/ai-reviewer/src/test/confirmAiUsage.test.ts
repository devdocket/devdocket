import { describe, it, expect, beforeEach, vi } from 'vitest';
import { window } from 'vscode';
import { confirmAiUsage } from '../confirmAiUsage';

describe('confirmAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when user clicks Continue', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Continue' as never);

    const result = await confirmAiUsage('Test message');

    expect(result).toBe(true);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'Test message',
      { modal: true },
      'Continue',
    );
  });

  it('returns false when user dismisses the dialog', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as never);

    const result = await confirmAiUsage('Test message');

    expect(result).toBe(false);
  });

  it('passes the message through to showWarningMessage', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Continue' as never);

    await confirmAiUsage('AI Code Review will send data to the model.');

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'AI Code Review will send data to the model.',
      { modal: true },
      'Continue',
    );
  });
});
