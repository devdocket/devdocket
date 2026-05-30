// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TierData } from '../views/mainTypes';

describe('sidebar Incoming tier multi-select', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
    // The webview's messaging module caches the vscode API on `window` so
    // subsequent calls reuse the same handle. Without clearing it, the next
    // test's freshly stubbed acquireVsCodeApi is never consulted and
    // postMessage routes to the previous test's spy.
    delete (window as any).__DEVDOCKET_VSCODE_API__;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('exposes Accept + Dismiss bulk actions after ctrl-clicking two incoming cards and posts batched inbox messages', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));

    const { App } = await import('../webview/sidebar/App');
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      render(h(App, {}), container!);
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'updateItems',
          tiers: [makeIncomingTier()],
        },
      }));
    });

    const cards = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(cards).toHaveLength(3);

    // Ctrl-click two cards to build a multi-selection on the Incoming tier.
    // The first ctrl-click selects a single card (no prior selection), the
    // second adds to the selection.
    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await act(async () => {
      cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });

    // Modifier-click on a multi-select tier must NOT open the card (no openItem post).
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openItem' }));

    // Selected cards should report aria-selected=true; unselected → aria-selected=false.
    expect(cards[0].getAttribute('aria-selected')).toBe('true');
    expect(cards[1].getAttribute('aria-selected')).toBe('true');
    expect(cards[2].getAttribute('aria-selected')).toBe('false');

    // The BulkActionBar should now be rendered with Accept + Dismiss buttons,
    // labelled "2 selected".
    const bulkBar = container.querySelector('.bulk-action-bar');
    expect(bulkBar).not.toBeNull();
    expect(bulkBar!.querySelector('.bulk-action-count')?.textContent).toBe('2 selected');
    const bulkButtons = Array.from(bulkBar!.querySelectorAll<HTMLButtonElement>('.bulk-action-btn:not(.bulk-action-clear)'));
    // Label rendering: each bulk button contains an aria-hidden icon span and
    // a label span; assert against aria-label which omits the icon glyph.
    const buttonLabels = bulkButtons.map(b => b.getAttribute('aria-label'));
    expect(buttonLabels).toEqual([
      'Accept 2 selected items',
      'Dismiss 2 selected items',
    ]);

    // Clicking Accept posts a bulkInboxAction { action: 'accept', items: [...] }
    // with the selected provider/external pairs in tier order.
    postMessage.mockClear();
    await act(async () => {
      bulkButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'bulkInboxAction',
      action: 'accept',
      items: [
        { providerId: 'github', externalId: 'inc-1' },
        { providerId: 'ado', externalId: 'inc-2' },
      ],
    });
  });

  it('posts a dismiss bulkInboxAction when Dismiss is clicked on a multi-selection', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));

    const { App } = await import('../webview/sidebar/App');
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      render(h(App, {}), container!);
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'updateItems', tiers: [makeIncomingTier()] },
      }));
    });

    const cards = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));

    // Click first, then shift-click the third to range-select all three.
    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await act(async () => {
      cards[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    });

    const bulkBar = container.querySelector('.bulk-action-bar');
    expect(bulkBar?.querySelector('.bulk-action-count')?.textContent).toBe('3 selected');

    const dismissBtn = Array.from(bulkBar!.querySelectorAll<HTMLButtonElement>('.bulk-action-btn'))
      .find(btn => btn.getAttribute('aria-label')?.startsWith('Dismiss '));
    expect(dismissBtn).toBeInstanceOf(HTMLButtonElement);

    postMessage.mockClear();
    await act(async () => {
      dismissBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'bulkInboxAction',
      action: 'dismiss',
      items: [
        { providerId: 'github', externalId: 'inc-1' },
        { providerId: 'ado', externalId: 'inc-2' },
        { providerId: 'github', externalId: 'inc-3' },
      ],
    });
  });

  it('marks the Incoming listbox as aria-multiselectable=true', async () => {
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    }));

    const { App } = await import('../webview/sidebar/App');
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      render(h(App, {}), container!);
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'updateItems', tiers: [makeIncomingTier()] },
      }));
    });

    const listbox = container.querySelector('#mission-control-tier-incoming');
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute('aria-multiselectable')).toBe('true');
  });
});

function makeIncomingTier(): TierData {
  return {
    id: 'incoming',
    name: 'Incoming',
    icon: '↓',
    collapsed: false,
    items: [
      {
        id: 'github::inc-1',
        title: 'Incoming 1',
        badges: [],
        tierType: 'incoming',
        providerId: 'github',
        externalId: 'inc-1',
      },
      {
        id: 'ado::inc-2',
        title: 'Incoming 2',
        badges: [],
        tierType: 'incoming',
        providerId: 'ado',
        externalId: 'inc-2',
      },
      {
        id: 'github::inc-3',
        title: 'Incoming 3',
        badges: [],
        tierType: 'incoming',
        providerId: 'github',
        externalId: 'inc-3',
      },
    ],
  };
}
