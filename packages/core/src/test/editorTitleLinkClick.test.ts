// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorItemData } from '../views/mainTypes';

declare global {
  interface Window {
    __DEVDOCKET_EDITOR_BOOTSTRAP__?: EditorItemData;
  }
}

describe('EditorApp title link clicks', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
    delete window.__DEVDOCKET_EDITOR_BOOTSTRAP__;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('posts exactly one openUrl message when the title link is clicked', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    window.__DEVDOCKET_EDITOR_BOOTSTRAP__ = makeEditorItem({
      title: 'Linked item',
      url: 'https://example.com/item/1',
    });

    const { EditorApp } = await import('../webview/editor/EditorApp');
    container = document.createElement('div');
    document.body.appendChild(container);
    render(h(EditorApp, {}), container);

    const link = container.querySelector('a.editor-title-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);

    link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'openUrl',
      url: 'https://example.com/item/1',
    });
  });
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
