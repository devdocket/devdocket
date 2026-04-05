import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { WorkGraph } from '../services/workGraph';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ITaskStore } from '../storage/taskStore';

function createMockStore(): ITaskStore {
  const items: Map<string, any> = new Map();
  return {
    loadAll: vi.fn(async () => Array.from(items.values())),
    save: vi.fn(async (item) => { items.set(item.id, item); }),
    saveAll: vi.fn(async (batch) => { for (const item of batch) { items.set(item.id, item); } }),
    delete: vi.fn(async (id) => { items.delete(id); }),
  };
}

function createMockWebviewPanel() {
  const messageListeners: Function[] = [];
  const disposeListeners: Function[] = [];
  return {
    webview: {
      html: '',
      cspSource: 'mock-csp-source',
      onDidReceiveMessage: vi.fn((listener: Function) => {
        messageListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      _fireMessage: (msg: any) => { messageListeners.forEach(l => l(msg)); },
    },
    onDidDispose: vi.fn((listener: Function) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    _fireDispose: () => { disposeListeners.forEach(l => l()); },
    dispose: vi.fn(),
    title: '',
    reveal: vi.fn(),
  };
}

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'test-item-1',
    title: 'Test Item',
    state: WorkItemState.New,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('WorkItemEditorPanel', () => {
  let store: ITaskStore;
  let graph: WorkGraph;
  let mockPanel: ReturnType<typeof createMockWebviewPanel>;
  let context: vscode.ExtensionContext;

  beforeEach(async () => {
    store = createMockStore();
    graph = new WorkGraph(store);
    await graph.load();
    context = createMockContext();
    mockPanel = createMockWebviewPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel as any);
    vi.mocked(vscode.window.showErrorMessage).mockReset();
  });

  describe('open', () => {
    it('creates a webview panel with correct type and title', async () => {
      const item = await graph.createItem({ title: 'My Task' });
      WorkItemEditorPanel.open(context, graph, item);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'workcenter.editItem',
        `Edit: My Task`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
    });

    it('adds a disposable to context subscriptions', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      expect(context.subscriptions.length).toBe(1);
      expect(context.subscriptions[0]).toHaveProperty('dispose');
    });

    it('sets webview HTML on creation', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      expect(mockPanel.webview.html).toContain('Edit Work Item');
      expect(mockPanel.webview.html).toContain('Task');
    });
  });

  describe('HTML generation', () => {
    it('title field is readonly for provider items', async () => {
      const item = await graph.createItem(
        { title: 'Provider Task' },
        { providerId: 'github', externalId: '42' },
      );
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      const titleMatch = html.match(/<input[^>]*id="title"[^>]*>/);
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![0]).toContain('readonly');
      expect(html).toContain('Title is managed by the provider');
    });

    it('title field is editable for manual items', async () => {
      const item = await graph.createItem({ title: 'Manual Task' });
      WorkItemEditorPanel.open(context, graph, item);

      // The title input should not have readonly attribute
      const html = mockPanel.webview.html;
      const titleMatch = html.match(/<input[^>]*id="title"[^>]*>/);
      expect(titleMatch).toBeTruthy();
      expect(titleMatch![0]).not.toContain('readonly');
      expect(html).not.toContain('Title is managed by the provider');
    });

    it('notes field is always editable', async () => {
      const item = await graph.createItem(
        { title: 'Provider Task' },
        { providerId: 'github', externalId: '42' },
      );
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      const notesMatch = html.match(/<textarea[^>]*id="notes"[^>]*>/);
      expect(notesMatch).toBeTruthy();
      expect(notesMatch![0]).not.toContain('readonly');
    });

    it('CSP meta tag includes nonce', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/);
    });

    it('script tag includes nonce', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      expect(html).toMatch(/<script nonce="[A-Za-z0-9]+">/);
    });

    it('CSP includes webview cspSource', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      expect(mockPanel.webview.html).toContain('mock-csp-source');
    });

    it('shows "Item not found" when item is missing', () => {
      // Open with an item that doesn't exist in the graph
      const fakeItem = makeItem({ id: 'nonexistent' });
      WorkItemEditorPanel.open(context, graph, fakeItem);

      expect(mockPanel.webview.html).toContain('Item not found.');
    });
  });

  describe('HTML escaping', () => {
    it('escapes special characters in title (via escapeAttr)', async () => {
      const item = await graph.createItem({ title: 'A & B <script>"alert"</script>' });
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      // The title is in an attribute value, so &, <, >, " should be escaped
      expect(html).toContain('&amp;');
      expect(html).toContain('&lt;');
      expect(html).toContain('&gt;');
      expect(html).toContain('&quot;');
      // Raw dangerous characters should not appear unescaped in the value attribute
      expect(html).not.toMatch(/value="[^"]*<script>/);
    });

    it('escapes special characters in notes (via escapeHtml)', async () => {
      const item = await graph.createItem({ title: 'Task', notes: '<b>bold</b> & "quotes"' });
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      // Notes are inside textarea (escapeHtml), so &, <, > should be escaped
      expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
      expect(html).toContain('&amp;');
    });

    it('renders empty notes without error', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      const html = mockPanel.webview.html;
      expect(html).toMatch(/<textarea id="notes"><\/textarea>/);
    });
  });

  describe('saveData via autosave message', () => {
    it('updates title and notes for manual items', async () => {
      const item = await graph.createItem({ title: 'Original' });
      WorkItemEditorPanel.open(context, graph, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Updated Title', notes: 'Some notes' },
      });

      // Allow async handler to complete
      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.title).toBe('Updated Title');
        expect(updated!.notes).toBe('Some notes');
      });
    });

    it('updates panel title after saving for manual items', async () => {
      const item = await graph.createItem({ title: 'Original' });
      WorkItemEditorPanel.open(context, graph, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'New Title', notes: '' },
      });

      await vi.waitFor(() => {
        expect(mockPanel.title).toBe('Edit: New Title');
      });
    });

    it('ignores autosave with empty title for manual items', async () => {
      const item = await graph.createItem({ title: 'Original' });
      const saveCountBefore = vi.mocked(store.save).mock.calls.length;
      WorkItemEditorPanel.open(context, graph, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: '', notes: 'notes' },
      });

      // Let pending microtasks run without relying on a fixed delay
      await Promise.resolve();
      expect(vi.mocked(store.save)).toHaveBeenCalledTimes(saveCountBefore);
      expect(graph.getItem(item.id)!.title).toBe('Original');
    });

    it('provider items cannot change title, only notes', async () => {
      const item = await graph.createItem(
        { title: 'Provider Title' },
        { providerId: 'github', externalId: '99' },
      );
      WorkItemEditorPanel.open(context, graph, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Attempted Change', notes: 'My notes' },
      });

      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.title).toBe('Provider Title');
        expect(updated!.notes).toBe('My notes');
      });
    });

    it('shows error when item no longer exists', async () => {
      const item = await graph.createItem({ title: 'Temp' });
      WorkItemEditorPanel.open(context, graph, item);

      // Delete the item from the graph
      await graph.deleteItem(item.id);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Updated', notes: '' },
      });

      await vi.waitFor(() => {
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('no longer exists'),
        );
      });
    });

    it('clears notes when empty string is sent', async () => {
      const item = await graph.createItem({ title: 'Task', notes: 'old notes' });
      WorkItemEditorPanel.open(context, graph, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Task', notes: '' },
      });

      await vi.waitFor(() => {
        const updated = graph.getItem(item.id);
        expect(updated!.notes).toBeUndefined();
      });
    });

    it('skips save when provider item patch is empty', async () => {
      const item = await graph.createItem(
        { title: 'Provider' },
        { providerId: 'github', externalId: '1' },
      );
      const saveCountBefore = vi.mocked(store.save).mock.calls.length;
      WorkItemEditorPanel.open(context, graph, item);

      mockPanel.webview._fireMessage({
        type: 'autosave',
        data: { title: 'Provider' },
      });

      await vi.waitFor(() => {
        expect(vi.mocked(store.save)).toHaveBeenCalledTimes(saveCountBefore);
      });
    });

    it('ignores unknown message types', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      expect(() => {
        mockPanel.webview._fireMessage({ type: 'unknown', data: {} });
      }).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('dispose via context subscription cleans up panel', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      // Dispose via the context subscription
      const sub = context.subscriptions[0] as vscode.Disposable;
      sub.dispose();

      expect(mockPanel.dispose).toHaveBeenCalled();
    });

    it('dispose via onDidDispose cleans up message subscription', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      // Get the message subscription disposable
      const msgDisposable = vi.mocked(mockPanel.webview.onDidReceiveMessage).mock.results[0].value;

      // Fire the onDidDispose event
      mockPanel._fireDispose();

      expect(msgDisposable.dispose).toHaveBeenCalled();
    });

    it('double dispose is safe', async () => {
      const item = await graph.createItem({ title: 'Task' });
      WorkItemEditorPanel.open(context, graph, item);

      const sub = context.subscriptions[0] as vscode.Disposable;
      sub.dispose();
      // Second dispose should not throw
      expect(() => sub.dispose()).not.toThrow();
    });
  });
});
