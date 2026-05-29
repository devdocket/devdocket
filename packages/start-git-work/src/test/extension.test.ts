import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workspace, extensions, window } from 'vscode';
import { activate } from '../extension';

describe('Start Git Work extension activation', () => {
  let mockContext: any;
  let mockApi: any;

  beforeEach(() => {
    vi.clearAllMocks();
    (workspace as any).workspaceFolders = [{ uri: { fsPath: '/mock/workspace' } }];

    mockContext = {
      globalState: {},
      subscriptions: {
        push: vi.fn(),
      },
    };

    mockApi = {
      registerAction: vi.fn(() => ({ dispose: vi.fn() })),
      registerActivityDetailRenderer: vi.fn(() => ({ dispose: vi.fn() })),
      onDidTransitionState: vi.fn(() => ({ dispose: vi.fn() })),
      getProviderItem: vi.fn(),
    };

    vi.mocked(extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: mockApi,
      activate: vi.fn(),
    } as any);
  });

  it('activates fully when no workspace folder is open', async () => {
    (workspace as any).workspaceFolders = [];

    await activate(mockContext);

    expect(window.createOutputChannel).toHaveBeenCalled();
    expect(extensions.getExtension).toHaveBeenCalled();
    expect(mockApi.registerAction).toHaveBeenCalled();
    expect(mockApi.registerActivityDetailRenderer).toHaveBeenCalled();
    expect(mockApi.onDidTransitionState).toHaveBeenCalled();
  });
});
