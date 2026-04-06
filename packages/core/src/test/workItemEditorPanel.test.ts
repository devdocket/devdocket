import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ViewColumn, window } from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';

type MessageHandler = (msg: any) => Promise<void>;
type DisposeHandler = () => void;

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    title: 'Test item',
    state: WorkItemState.InProgress,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockWebviewPanel() {
  let messageHandler: MessageHandler | undefined;
  let disposeHandler: DisposeHandler | undefined;
  const panel = {
    title: '',
    webview: {
      html: '',
      cspSource: 'https://test.csp',
      onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      }),
    },
    onDidDispose: vi.fn((handler: DisposeHandler) => {
      disposeHandler = handler;
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
  };
  return {
    panel,
    simulateMessage: (msg: any) => messageHandler?.(msg),
    simulateDispose: () => disposeHandler?.(),
  };
}

function createMockWorkGraph(item?: WorkItem) {
  return {
    getItem: vi.fn((id: string) => (item && item.id === id ? item : undefined)),
    updateItem: vi.fn(async () => {}),
  };
}

function createMockContext() {
  const subscriptions: { dispose: () => void }[] = [];
  return {
    subscriptions,
    extensionUri: { toString: () => 'file:///ext' },
  } as any;
}

function openPanel(
  item: WorkItem,
  workGraph: ReturnType<typeof createMockWorkGraph>,
  mock: ReturnType<typeof createMockWebviewPanel>,
  context = createMockContext(),
) {
  vi.mocked(window.createWebviewPanel).mockReturnValue(mock.panel as any);
  WorkItemEditorPanel.open(context, workGraph as any, item);
  return context;
}

describe('WorkItemEditorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('open (panel creation)', () => {
    it('should create a webview panel with correct title', () => {
      const item = makeItem({ title: 'My Task' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(window.createWebviewPanel).toHaveBeenCalledWith(
        'workcenter.editItem',
        'Edit: My Task',
        ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
    });

    it('should push a disposable onto context.subscriptions', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const ctx = openPanel(item, createMockWorkGraph(item), mock);

      expect(ctx.subscriptions.length).toBe(1);
      expect(typeof ctx.subscriptions[0].dispose).toBe('function');
    });

    it('should register a message handler on the webview', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(1);
    });

    it('should register a dispose handler on the panel', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.onDidDispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTML generation', () => {
    it('should render HTML with item title and notes', () => {
      const item = makeItem({ title: 'My Title', notes: 'My Notes' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('My Title');
      expect(mock.panel.webview.html).toContain('My Notes');
    });

    it('should render "Item not found" when item does not exist', () => {
      const item = makeItem({ id: 'missing' });
      const mock = createMockWebviewPanel();
      const workGraph = createMockWorkGraph(); // no item configured
      openPanel(item, workGraph, mock);

      expect(mock.panel.webview.html).toContain('Item not found');
    });

    it('should render readonly title for provider items', () => {
      const item = makeItem({ providerId: 'github' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toMatch(/<input\b(?=[^>]*\bid="title")(?=[^>]*\breadonly)[^>]*>/);
      expect(mock.panel.webview.html).toContain('Title is managed by the provider');
    });

    it('should not render readonly for non-provider items', () => {
      const item = makeItem({ providerId: undefined });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).not.toContain('Title is managed by the provider');
    });

    it('should escape HTML special characters in notes', () => {
      const item = makeItem({ notes: '<script>alert("xss")</script>' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).not.toContain('<script>alert');
      expect(mock.panel.webview.html).toContain('&lt;script&gt;');
    });

    it('should escape special characters in title attribute', () => {
      const item = makeItem({ title: 'Item "with" <quotes>' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('&quot;with&quot;');
      expect(mock.panel.webview.html).toContain('&lt;quotes&gt;');
    });

    it('should render empty textarea for item with no notes', () => {
      const item = makeItem({ notes: undefined });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('<textarea id="notes"></textarea>');
    });

    it('should include a nonce and CSP meta tag', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('Content-Security-Policy');
      expect(mock.panel.webview.html).toContain('nonce-');
      expect(mock.panel.webview.html).toContain(mock.panel.webview.cspSource);
    });

    it('should handle very long notes', () => {
      const longNotes = 'A'.repeat(10000);
      const item = makeItem({ notes: longNotes });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain(longNotes);
    });
  });

  describe('message handling (autosave)', () => {
    it('should save title and notes on autosave message', async () => {
      const item = makeItem({ title: 'Old Title' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'New Title', notes: 'Some notes' },
      });

      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        title: 'New Title',
        notes: 'Some notes',
      });
    });

    it('should update panel title for non-provider items', async () => {
      const item = makeItem({ title: 'Old Title', providerId: undefined });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Updated Title', notes: '' },
      });

      expect(mock.panel.title).toBe('Edit: Updated Title');
    });

    it('should not update panel title for provider items', async () => {
      const item = makeItem({ title: 'Provider Title', providerId: 'github' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);
      mock.panel.title = 'Edit: Provider Title';

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Provider Title', notes: 'new note' },
      });

      // Title should not change for provider items (title not in patch)
      expect(mock.panel.title).toBe('Edit: Provider Title');
    });

    it('should skip save when title is empty for non-provider items', async () => {
      const item = makeItem({ providerId: undefined });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: '', notes: 'Some notes' },
      });

      expect(workGraph.updateItem).not.toHaveBeenCalled();
    });

    it('should save notes only for provider items', async () => {
      const item = makeItem({ providerId: 'github', title: 'Provider Item' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Provider Item', notes: 'Updated notes' },
      });

      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        notes: 'Updated notes',
      });
    });

    it('should set notes to undefined when notes field is empty string', async () => {
      const item = makeItem({ notes: 'old notes' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Test item', notes: '' },
      });

      expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', {
        title: 'Test item',
        notes: undefined,
      });
    });

    it('should show error message when item no longer exists during save', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      // Make item disappear after panel was created
      workGraph.getItem.mockReturnValue(undefined);

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'New', notes: '' },
      });

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('no longer exists'),
      );
    });

    it('should show error message when updateItem throws', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      workGraph.updateItem.mockRejectedValue(new Error('disk full'));

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Test item', notes: '' },
      });

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('disk full'),
      );
    });

    it('should handle non-Error thrown values in error message', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      workGraph.updateItem.mockRejectedValue('string error');

      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Test item', notes: '' },
      });

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('string error'),
      );
    });

    it('should ignore messages with unknown type', async () => {
      const item = makeItem();
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      await mock.simulateMessage({ type: 'unknown', data: {} });

      expect(workGraph.updateItem).not.toHaveBeenCalled();
    });

    it('should not call updateItem when patch is empty (provider item with no notes change)', async () => {
      const item = makeItem({ providerId: 'github', title: 'Provider Item' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      // Simulate message without 'notes' key in data
      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Provider Item' },
      });

      expect(workGraph.updateItem).not.toHaveBeenCalled();
    });
  });

  describe('disposal', () => {
    it('should dispose message subscription when panel is disposed via onDidDispose', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const msgDisposable = { dispose: vi.fn() };
      mock.panel.webview.onDidReceiveMessage.mockReturnValue(msgDisposable);

      openPanel(item, createMockWorkGraph(item), mock);
      mock.simulateDispose();

      expect(msgDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose panel and subscription when dispose() is called via context', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const msgDisposable = { dispose: vi.fn() };
      mock.panel.webview.onDidReceiveMessage.mockReturnValue(msgDisposable);

      const ctx = openPanel(item, createMockWorkGraph(item), mock);
      ctx.subscriptions[0].dispose();

      expect(msgDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(mock.panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call dispose multiple times', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      const msgDisposable = { dispose: vi.fn() };
      mock.panel.webview.onDidReceiveMessage.mockReturnValue(msgDisposable);

      const ctx = openPanel(item, createMockWorkGraph(item), mock);

      // Dispose via context, then simulate panel dispose
      ctx.subscriptions[0].dispose();
      mock.simulateDispose();

      expect(msgDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(mock.panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('should not update panel title after disposal', async () => {
      const item = makeItem({ title: 'Original' });
      const workGraph = createMockWorkGraph(item);
      const mock = createMockWebviewPanel();
      openPanel(item, workGraph, mock);

      // Dispose first
      mock.simulateDispose();
      mock.panel.title = 'Edit: Original';

      // Then try to save
      await mock.simulateMessage({
        type: 'autosave',
        data: { title: 'Changed', notes: '' },
      });

      // Title should remain unchanged because panel is disposed
      expect(mock.panel.title).toBe('Edit: Original');
    });
  });

  describe('special characters and edge cases', () => {
    it('should handle ampersands in title', () => {
      const item = makeItem({ title: 'Tom & Jerry' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('Tom &amp; Jerry');
    });

    it('should handle double quotes in title', () => {
      const item = makeItem({ title: 'Say "hello"' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('Say &quot;hello&quot;');
    });

    it('should handle special characters in notes', () => {
      const item = makeItem({ notes: 'a < b && c > d' });
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('a &lt; b &amp;&amp; c &gt; d');
    });

    it('should include autosave script in HTML output', () => {
      const item = makeItem();
      const mock = createMockWebviewPanel();
      openPanel(item, createMockWorkGraph(item), mock);

      expect(mock.panel.webview.html).toContain('scheduleAutosave');
      expect(mock.panel.webview.html).toContain('acquireVsCodeApi');
    });
  });
});
