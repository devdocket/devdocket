// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TierData } from '../views/mainTypes';

describe('per-card actions on a multi-selection', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
    // Same caveat as sidebarIncomingMultiSelect.test.ts: the messaging
    // module caches the vscode API on `window`, so stubs leak between
    // tests if we don't reset it explicitly.
    delete (window as any).__DEVDOCKET_VSCODE_API__;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function mountWithTier(tier: TierData): Promise<{
    cards: HTMLElement[];
    postMessage: ReturnType<typeof vi.fn>;
  }> {
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
        data: { type: 'updateItems', tiers: [tier] },
      }));
    });
    const cards = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
    return { cards, postMessage };
  }

  function getPerCardButton(card: HTMLElement, label: RegExp): HTMLButtonElement {
    const button = Array.from(card.querySelectorAll<HTMLButtonElement>('.item-action-btn'))
      .find(btn => label.test(btn.getAttribute('aria-label') ?? ''));
    expect(button, `per-card button matching ${label} on card ${card.getAttribute('data-item-id')}`).toBeTruthy();
    return button!;
  }

  it('dispatches a bulkInboxAction (not a single acceptItem) when Accept is clicked on a card that is part of a multi-selection', async () => {
    const { cards, postMessage } = await mountWithTier(makeIncomingTier());

    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await act(async () => {
      cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });

    // Clear any messages from the selection flow itself so the
    // assertions below only see the action's effect.
    postMessage.mockClear();

    const acceptButton = getPerCardButton(cards[0], /^Accept \(/);
    await act(async () => {
      acceptButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'bulkInboxAction',
      action: 'accept',
      items: [
        { providerId: 'github', externalId: 'inc-1' },
        { providerId: 'ado', externalId: 'inc-2' },
      ],
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'acceptItem' }));
  });

  it('dispatches a bulkInboxAction dismiss when Dismiss is clicked on a card that is part of a multi-selection', async () => {
    const { cards, postMessage } = await mountWithTier(makeIncomingTier());

    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await act(async () => {
      cards[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    });

    postMessage.mockClear();

    const dismissButton = getPerCardButton(cards[1], /^Dismiss$/);
    await act(async () => {
      dismissButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dismissItem' }));
  });

  it('dispatches a bulkTransition (not a single transitionState) when Start is clicked on a card that is part of a multi-selection', async () => {
    const { cards, postMessage } = await mountWithTier(makeReadyTier());

    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await act(async () => {
      cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });

    postMessage.mockClear();

    const startButton = getPerCardButton(cards[0], /^Start$/);
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'bulkTransition',
      itemIds: expect.arrayContaining(['ready-1', 'ready-2']),
      targetState: 'InProgress',
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'transitionState' }));
  });

  it('still posts a single-item transitionState when the per-card button is clicked on a card outside the multi-selection', async () => {
    const { cards, postMessage } = await mountWithTier(makeReadyTier());

    // Select only cards 0 and 1, then act on card 2 (NOT in selection).
    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await act(async () => {
      cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });

    postMessage.mockClear();

    const startButton = getPerCardButton(cards[2], /^Start$/);
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'transitionState',
      itemId: 'ready-3',
      targetState: 'InProgress',
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bulkTransition' }));
  });

  it('still posts a single-item transitionState when only one item is "selected" (size === 1 is not really a multi-selection)', async () => {
    const { cards, postMessage } = await mountWithTier(makeReadyTier());

    // Single ctrl-click — selection has exactly one item; the bulk-action
    // bar requires size > 1 to render, so dispatching as bulk for a
    // size-1 "selection" would be a regression.
    await act(async () => {
      cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });

    postMessage.mockClear();

    const startButton = getPerCardButton(cards[0], /^Start$/);
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'transitionState',
      itemId: 'ready-1',
      targetState: 'InProgress',
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bulkTransition' }));
  });
});

function makeIncomingTier(): TierData {
  return {
    id: 'incoming',
    name: 'Incoming',
    icon: '↓',
    collapsed: false,
    items: [
      { id: 'github::inc-1', title: 'Incoming 1', badges: [], tierType: 'incoming', providerId: 'github', externalId: 'inc-1' },
      { id: 'ado::inc-2', title: 'Incoming 2', badges: [], tierType: 'incoming', providerId: 'ado', externalId: 'inc-2' },
      { id: 'github::inc-3', title: 'Incoming 3', badges: [], tierType: 'incoming', providerId: 'github', externalId: 'inc-3' },
    ],
  };
}

function makeReadyTier(): TierData {
  return {
    id: 'ready-to-start',
    name: 'Ready to Start',
    icon: '○',
    collapsed: false,
    items: [
      { id: 'ready-1', title: 'Ready 1', badges: [], tierType: 'readyToStart' },
      { id: 'ready-2', title: 'Ready 2', badges: [], tierType: 'readyToStart' },
      { id: 'ready-3', title: 'Ready 3', badges: [], tierType: 'readyToStart' },
    ],
  };
}
