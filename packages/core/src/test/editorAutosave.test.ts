// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorItemData } from '../views/mainTypes';

declare global {
  interface Window {
    __DEVDOCKET_EDITOR_BOOTSTRAP__?: EditorItemData;
  }
}

describe('EditorApp autosave UI', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
    delete window.__DEVDOCKET_EDITOR_BOOTSTRAP__;
    delete (window as typeof window & { __DEVDOCKET_VSCODE_API__?: unknown }).__DEVDOCKET_VSCODE_API__;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shows pending, saving, and saved states for notes autosave', async () => {
    vi.useFakeTimers({ now: 1000 });
    const postMessage = vi.fn();
    await renderEditor(postMessage);

    updateTextarea('Draft notes');
    await Promise.resolve();
    expect(container!.textContent).toContain('Unsaved changes');

    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'autosave',
      requestId: 'autosave-1',
      data: { notes: 'Draft notes' },
    }));
    expect(container!.textContent).toContain('Saving…');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'autosaveAck', requestId: 'autosave-1', savedAt: 1000 },
    }));
    await Promise.resolve();

    expect(container!.textContent).toContain('Saved ·');
  });

  it('flushes pending autosave with Ctrl+S', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    await renderEditor(postMessage);

    updateTextarea('Keyboard save');
    await vi.advanceTimersByTimeAsync(499);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'autosave',
      requestId: 'autosave-1',
      data: { notes: 'Keyboard save' },
    }));
  });

  it('shows inline errors and retries failed autosaves', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    await renderEditor(postMessage);

    updateTextarea('Retry me');
    await vi.advanceTimersByTimeAsync(500);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'autosaveError', requestId: 'autosave-1', message: 'disk full' },
    }));
    await Promise.resolve();

    expect(container!.textContent).toContain('Save failed');
    expect(container!.textContent).toContain('Couldn’t save changes: disk full');

    const retry = container!.querySelector('button.editor-autosave-retry') as HTMLButtonElement | null;
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'autosave',
      requestId: 'autosave-2',
      data: { notes: 'Retry me' },
    }));
  });

  async function renderEditor(postMessage: ReturnType<typeof vi.fn>) {
    delete (window as typeof window & { __DEVDOCKET_VSCODE_API__?: unknown }).__DEVDOCKET_VSCODE_API__;
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    window.__DEVDOCKET_EDITOR_BOOTSTRAP__ = makeEditorItem();

    const { EditorApp } = await import('../webview/editor/EditorApp');
    container = document.createElement('div');
    document.body.appendChild(container);
    render(h(EditorApp, {}), container);
  }

  function updateTextarea(value: string) {
    const textarea = container!.querySelector('textarea.editor-textarea') as HTMLTextAreaElement | null;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.focus();
    textarea!.value = value;
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

function makeEditorItem(overrides: Partial<EditorItemData> = {}): EditorItemData {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Test item',
    state: 'New',
    notes: '',
    createdAt: now,
    updatedAt: now,
    badges: [],
    isProviderManaged: true,
    validTransitions: [],
    hasActions: false,
    activityLog: [],
    relatedItems: [],
    ...overrides,
  };
}
