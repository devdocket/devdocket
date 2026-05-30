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

  it('shows the autosave status dot through pending → saving → saved (then fades) for notes edits', async () => {
    vi.useFakeTimers({ now: 1000 });
    const postMessage = vi.fn();
    await renderEditor(postMessage);

    updateTextarea('Draft notes');
    await Promise.resolve();
    expectDotTone('pending');

    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'autosave',
      requestId: 'autosave-1',
      data: { notes: 'Draft notes' },
    }));
    expectDotTone('saving');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'autosaveAck', requestId: 'autosave-1', savedAt: 1000 },
    }));
    await Promise.resolve();
    expectDotTone('saved');

    // The saved dot quietly fades after a short visible window.
    await vi.advanceTimersByTimeAsync(2500);
    expect(container!.querySelector('.editor-autosave-dot')).toBeNull();
  });

  it('does not flush autosave on Ctrl+S (shortcut removed)', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    await renderEditor(postMessage);

    // No prior typing — Ctrl+S must not trigger autosave from a clean state and must not preventDefault.
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'autosave' }));

    // After typing, Ctrl+S still does not bypass the debounce — only the timer can fire the autosave.
    updateTextarea('Keyboard should not save');
    const eventWhileTyping = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(eventWhileTyping);
    expect(eventWhileTyping.defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'autosave' }));

    // The normal debounce still works (regression guard: we removed the shortcut, not the autosave).
    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'autosave',
      data: { notes: 'Keyboard should not save' },
    }));
  });

  it('shows an item-level error banner with Retry on failure', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    await renderEditor(postMessage);

    updateTextarea('Retry me');
    await vi.advanceTimersByTimeAsync(500);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'autosaveError', requestId: 'autosave-1', message: 'disk full' },
    }));
    await Promise.resolve();

    expectDotTone('error');
    expect(container!.textContent).toContain('Couldn’t save changes: disk full');

    const banner = container!.querySelector('.editor-autosave-error');
    expect(banner).not.toBeNull();
    // The banner sits at the item level (a direct child of editor-app), not nested inside the notes field.
    expect(banner!.parentElement?.classList.contains('editor-app')).toBe(true);

    const retry = container!.querySelector('button.editor-autosave-retry') as HTMLButtonElement | null;
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'autosave',
      requestId: 'autosave-2',
      data: { notes: 'Retry me' },
    }));
  });

  it('autosaves manual items when editing the title, URL, or notes (single item-level indicator)', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    await renderEditor(postMessage, { isProviderManaged: false, title: 'Initial', url: '' });

    const titleInput = container!.querySelector<HTMLInputElement>('input.editor-title-input');
    expect(titleInput).not.toBeNull();
    titleInput!.focus();
    titleInput!.value = 'Updated title';
    titleInput!.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expectDotTone('pending');

    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'autosave',
      data: { notes: '', title: 'Updated title', url: '' },
    }));

    // Exactly one item-level dot — feedback is not duplicated per field.
    expect(container!.querySelectorAll('.editor-autosave-dot').length).toBe(1);
  });

  function expectDotTone(tone: 'pending' | 'saving' | 'saved' | 'error') {
    const dot = container!.querySelector('.editor-autosave-dot');
    expect(dot, `expected an autosave dot in tone "${tone}"`).not.toBeNull();
    expect(dot!.classList.contains(`editor-autosave-dot--${tone}`)).toBe(true);
  }

  async function renderEditor(postMessage: ReturnType<typeof vi.fn>, overrides: Partial<EditorItemData> = {}) {
    delete (window as typeof window & { __DEVDOCKET_VSCODE_API__?: unknown }).__DEVDOCKET_VSCODE_API__;
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    window.__DEVDOCKET_EDITOR_BOOTSTRAP__ = makeEditorItem(overrides);

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
