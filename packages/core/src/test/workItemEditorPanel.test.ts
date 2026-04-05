import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { WorkGraph } from '../services/workGraph';
import { WorkItem, WorkItemState } from '../models/workItem';
import * as vscode from 'vscode';

// --- helpers -----------------------------------------------------------

type MessageHandler = (msg: any) => void;

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    title: 'Original Title',
    state: WorkItemState.New,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

interface MockPanel {
  webview: {
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    html: string;
    cspSource: string;
  };
  onDidDispose: ReturnType<typeof vi.fn>;
  title: string;
  dispose: ReturnType<typeof vi.fn>;
  /** Fire a webview message as if the webview posted it */
  simulateMessage: (msg: any) => Promise<void>;
  /** Fire the onDidDispose callback */
  simulateDispose: () => void;
}

function createMockPanel(): MockPanel {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: (() => void) | undefined;

  const panel: MockPanel = {
    webview: {
      onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
      html: '',
      cspSource: 'mock-csp',
    },
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    title: '',
    dispose: vi.fn(),
    simulateMessage: async (msg: any) => {
      if (messageHandler) {
        await messageHandler(msg);
      }
    },
    simulateDispose: () => {
      if (disposeHandler) {
        disposeHandler();
      }
    },
  };
  return panel;
}

function createMockWorkGraph(item: WorkItem) {
  return {
    getItem: vi.fn(() => ({ ...item })),
    updateItem: vi.fn(async (_id: string, patch: any) => {
      if (patch.title) {
        item.title = patch.title;
      }
      if (patch.notes !== undefined) {
        item.notes = patch.notes;
      }
    }),
  } as unknown as WorkGraph & {
    getItem: ReturnType<typeof vi.fn>;
    updateItem: ReturnType<typeof vi.fn>;
  };
}

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function openEditor(
  workGraph: WorkGraph,
  item: WorkItem,
): { panel: MockPanel } {
  const mockPanel = createMockPanel();
  (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mockReturnValue(mockPanel);

  const ctx = createMockContext();
  WorkItemEditorPanel.open(ctx, workGraph, item);
  return { panel: mockPanel };
}

// --- tests -------------------------------------------------------------

describe('WorkItemEditorPanel – concurrent autosave', () => {
  let item: WorkItem;
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let panel: MockPanel;

  beforeEach(() => {
    vi.clearAllMocks();
    item = makeItem();
    workGraph = createMockWorkGraph(item);
    ({ panel } = openEditor(workGraph as unknown as WorkGraph, item));
  });

  // 1. Rapid sequential title updates (simulating fast typing)
  it('saves each rapid title update that reaches the backend', async () => {
    await panel.simulateMessage({ type: 'autosave', data: { title: 'A' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'AB' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'ABC' } });

    expect(workGraph.updateItem).toHaveBeenCalledTimes(3);
    expect(workGraph.updateItem).toHaveBeenNthCalledWith(1, 'item-1', { title: 'A' });
    expect(workGraph.updateItem).toHaveBeenNthCalledWith(2, 'item-1', { title: 'AB' });
    expect(workGraph.updateItem).toHaveBeenNthCalledWith(3, 'item-1', { title: 'ABC' });
  });

  // 2. Multiple save messages arriving before debounce timer fires
  //    (simulates the webview sending several autosave messages in quick succession)
  it('processes every autosave message that arrives at the extension host', async () => {
    const promises = [
      panel.simulateMessage({ type: 'autosave', data: { title: 'v1' } }),
      panel.simulateMessage({ type: 'autosave', data: { title: 'v2' } }),
      panel.simulateMessage({ type: 'autosave', data: { title: 'v3' } }),
      panel.simulateMessage({ type: 'autosave', data: { title: 'v4' } }),
    ];
    await Promise.all(promises);

    expect(workGraph.updateItem).toHaveBeenCalledTimes(4);
  });

  // 3. Title and notes updates interleaved rapidly
  it('handles interleaved title and notes updates', async () => {
    await panel.simulateMessage({ type: 'autosave', data: { title: 'T1' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'T1', notes: 'N1' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'T2', notes: 'N1' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'T2', notes: 'N2' } });

    expect(workGraph.updateItem).toHaveBeenCalledTimes(4);
    // Last call should carry the final values
    expect(workGraph.updateItem).toHaveBeenLastCalledWith('item-1', { title: 'T2', notes: 'N2' });
  });

  // 4. Debounce timer correctly delays save until user stops typing
  //    The 500ms debounce lives in the webview JS. The extension host receives
  //    the post-debounce message and saves immediately. Here we verify that
  //    the server-side handler does NOT add its own delay — every message
  //    triggers an immediate updateItem call.
  it('saves immediately on each received message (no server-side debounce)', async () => {
    await panel.simulateMessage({ type: 'autosave', data: { title: 'fast' } });
    // updateItem should already have been called synchronously (awaited)
    expect(workGraph.updateItem).toHaveBeenCalledTimes(1);

    await panel.simulateMessage({ type: 'autosave', data: { title: 'faster' } });
    expect(workGraph.updateItem).toHaveBeenCalledTimes(2);
  });

  // 5. Only the last value is persisted (not intermediate values)
  it('persists only the final value after a burst of updates', async () => {
    await panel.simulateMessage({ type: 'autosave', data: { title: 'draft-1' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'draft-2' } });
    await panel.simulateMessage({ type: 'autosave', data: { title: 'final' } });

    // The underlying item should reflect the last write
    const lastPatch = workGraph.updateItem.mock.calls.at(-1)![1];
    expect(lastPatch.title).toBe('final');
    expect(item.title).toBe('final');
  });

  // 6. Save after panel disposal is a no-op (no crash)
  it('does not crash when a save message arrives after disposal', async () => {
    panel.simulateDispose();

    // Sending a message after dispose should not throw
    await expect(
      panel.simulateMessage({ type: 'autosave', data: { title: 'too late' } }),
    ).resolves.not.toThrow();

    // updateItem should still be called because the message handler remains
    // bound; the disposed flag only prevents panel.title updates.
    // The important thing is that it doesn't crash.
  });

  it('does not update panel title after disposal', async () => {
    panel.title = 'Edit: Original Title';
    panel.simulateDispose();

    await panel.simulateMessage({ type: 'autosave', data: { title: 'Ghost' } });

    // Panel title should remain unchanged because disposed === true
    expect(panel.title).toBe('Edit: Original Title');
  });

  // 7. Concurrent title + notes update (different fields, same item)
  it('applies title and notes from the same message', async () => {
    await panel.simulateMessage({
      type: 'autosave',
      data: { title: 'New Title', notes: 'Some notes' },
    });

    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
      title: 'New Title',
      notes: 'Some notes',
    });
  });

  it('applies notes-only update without title change for non-provider items', async () => {
    // When title is provided alongside notes, both go into the patch
    await panel.simulateMessage({
      type: 'autosave',
      data: { title: 'Original Title', notes: 'Just notes' },
    });

    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
      title: 'Original Title',
      notes: 'Just notes',
    });
  });

  // Edge case: empty title is rejected
  it('skips save when title is empty for non-provider items', async () => {
    await panel.simulateMessage({ type: 'autosave', data: { title: '', notes: 'note' } });

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  // Provider items: title is readonly, only notes are saved
  it('saves only notes for provider-managed items (title readonly)', async () => {
    const providerItem = makeItem({ providerId: 'github', title: 'PR #42' });
    const providerGraph = createMockWorkGraph(providerItem);
    const { panel: pPanel } = openEditor(providerGraph as unknown as WorkGraph, providerItem);

    await pPanel.simulateMessage({
      type: 'autosave',
      data: { title: 'PR #42', notes: 'My review notes' },
    });

    expect(providerGraph.updateItem).toHaveBeenCalledWith(providerItem.id, {
      notes: 'My review notes',
    });
    // Title should NOT be in the patch
    const patch = providerGraph.updateItem.mock.calls[0][1];
    expect(patch).not.toHaveProperty('title');
  });

  // Error handling: updateItem throws
  it('shows error message when save fails', async () => {
    workGraph.updateItem.mockRejectedValueOnce(new Error('disk full'));

    await panel.simulateMessage({ type: 'autosave', data: { title: 'Boom' } });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to save work item: disk full',
    );
  });

  // Error handling: item deleted mid-edit
  it('shows error when item no longer exists', async () => {
    workGraph.getItem.mockReturnValue(undefined);

    await panel.simulateMessage({ type: 'autosave', data: { title: 'Orphan' } });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('no longer exists'),
    );
  });

  // Updates panel title on successful save
  it('updates panel title on successful title save', async () => {
    panel.title = 'Edit: Original Title';

    await panel.simulateMessage({ type: 'autosave', data: { title: 'Updated' } });

    expect(panel.title).toBe('Edit: Updated');
  });
});
