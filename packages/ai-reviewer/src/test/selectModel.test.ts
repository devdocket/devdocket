import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lm, window } from 'vscode';
import { selectModel } from '../selectModel';

function createMockModel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'model-1',
    name: 'GPT-4o',
    vendor: 'copilot',
    family: 'gpt-4o',
    sendRequest: vi.fn(),
    ...overrides,
  };
}

describe('selectModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined and warns when no models are available', async () => {
    vi.mocked(lm.selectChatModels).mockResolvedValue([]);

    const result = await selectModel('Test Action');

    expect(result).toBeUndefined();
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'Test Action: No language model available. Install GitHub Copilot.',
    );
  });

  it('auto-selects when only one model is available', async () => {
    const model = createMockModel();
    vi.mocked(lm.selectChatModels).mockResolvedValue([model]);

    const result = await selectModel('Test Action');

    expect(result).toBe(model);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows QuickPick when multiple models are available', async () => {
    const model1 = createMockModel({ id: 'model-1', name: 'GPT-4o', vendor: 'copilot', family: 'gpt-4o' });
    const model2 = createMockModel({ id: 'model-2', name: 'Claude Sonnet', vendor: 'copilot', family: 'claude-sonnet' });
    vi.mocked(lm.selectChatModels).mockResolvedValue([model1, model2]);
    vi.mocked(window.showQuickPick).mockResolvedValue({ label: 'Claude Sonnet', description: 'copilot · claude-sonnet', model: model2 } as never);

    const result = await selectModel('Test Action');

    expect(result).toBe(model2);
    expect(window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: 'GPT-4o', description: 'copilot · gpt-4o' }),
        expect.objectContaining({ label: 'Claude Sonnet', description: 'copilot · claude-sonnet' }),
      ]),
      expect.objectContaining({
        title: 'Test Action: Select AI Model',
        placeHolder: 'Choose a language model',
      }),
    );
  });

  it('returns undefined when user cancels QuickPick', async () => {
    const model1 = createMockModel({ id: 'model-1', name: 'GPT-4o' });
    const model2 = createMockModel({ id: 'model-2', name: 'Claude' });
    vi.mocked(lm.selectChatModels).mockResolvedValue([model1, model2]);
    vi.mocked(window.showQuickPick).mockResolvedValue(undefined as never);

    const result = await selectModel('Test Action');

    expect(result).toBeUndefined();
  });

  it('passes the action title to QuickPick title', async () => {
    const model1 = createMockModel({ id: 'm1', name: 'A' });
    const model2 = createMockModel({ id: 'm2', name: 'B' });
    vi.mocked(lm.selectChatModels).mockResolvedValue([model1, model2]);
    vi.mocked(window.showQuickPick).mockResolvedValue({ model: model1 } as never);

    await selectModel('AI Code Review');

    expect(window.showQuickPick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'AI Code Review: Select AI Model' }),
    );
  });
});
