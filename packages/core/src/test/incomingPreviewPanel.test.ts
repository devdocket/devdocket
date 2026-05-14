import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter, window } from 'vscode';
import { IncomingPreviewPanel } from '../views/incomingPreviewPanel';

type MessageHandler = (message: unknown) => void | Promise<void>;
type DisposeHandler = () => void;

function createMockWebviewPanel() {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: DisposeHandler | undefined;
  const panel = {
    title: '',
    webview: {
      html: '',
      cspSource: 'mock-csp-source',
      asWebviewUri: vi.fn((uri: { fsPath?: string; path?: string; toString?: () => string }) => ({
        toString: () => `webview-resource:${uri.fsPath ?? uri.path ?? uri.toString?.() ?? ''}`,
      })),
      onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
        return { dispose: vi.fn(() => { messageHandler = undefined; }) };
      }),
      postMessage: vi.fn(async () => true),
    },
    onDidDispose: vi.fn((handler: DisposeHandler) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
    reveal: vi.fn(),
  };

  return {
    panel,
    simulateMessage: (message: unknown) => messageHandler?.(message) ?? Promise.resolve(),
    simulateDispose: () => disposeHandler?.(),
  };
}

function createMockProviderRegistry(discoveredByProvider: Record<string, any[]>) {
  const changeEmitter = new EventEmitter<void>();
  return {
    getProviderItems: vi.fn((providerId: string) => discoveredByProvider[providerId] ?? []),
    getAllProviderItems: vi.fn(() => new Map(Object.entries(discoveredByProvider))),
    getProviderLabel: vi.fn((providerId: string) => providerId === 'github' ? 'GitHub' : providerId),
    onDidChangeProviderItems: changeEmitter.event,
  };
}

function createMockStateStore() {
  const changeEmitter = new EventEmitter<void>();
  const states = new Map<string, string>();
  return {
    getState: vi.fn((providerId: string, externalId: string) => states.get(`${providerId}::${externalId}`)),
    setState: vi.fn(async (providerId: string, externalId: string, state: string) => {
      states.set(`${providerId}::${externalId}`, state);
      changeEmitter.fire();
    }),
    onDidChange: changeEmitter.event,
  };
}

function createMockReadStateStore() {
  return {
    add: vi.fn(async () => true),
  };
}

function createMockWorkGraph() {
  return {
    getAll: vi.fn(() => []),
    getItem: vi.fn(() => undefined),
    findItemByProvenance: vi.fn(() => undefined),
    createItem: vi.fn(async (input: { title: string; description?: string }, provenance?: { providerId: string; externalId: string; url?: string; group?: string }) => ({
      id: 'created-1',
      title: input.title,
      description: input.description,
      providerId: provenance?.providerId,
      externalId: provenance?.externalId,
      url: provenance?.url,
      group: provenance?.group,
    })),
  };
}

function createMockContext() {
  return {
    extensionUri: vscode.Uri.file(process.cwd()),
    subscriptions: [],
  };
}

describe('IncomingPreviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers undo when dismissing a preview item', async () => {
    const mockPanel = createMockWebviewPanel();
    vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel.panel as any);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Undo' as any);
    const stateStore = createMockStateStore();

    IncomingPreviewPanel.open(
      createMockContext() as any,
      createMockProviderRegistry({
        github: [{ externalId: 'preview-1', title: 'Preview item', description: 'Details' }],
      }) as any,
      stateStore as any,
      createMockReadStateStore() as any,
      createMockWorkGraph() as any,
      'github',
      'preview-1',
    );

    await mockPanel.simulateMessage({ type: 'dismissItem' });

    await vi.waitFor(() => {
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'preview-1', 'dismissed');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Dismissed "Preview item"', 'Undo');
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'preview-1', 'unseen');
    });
  });
});
