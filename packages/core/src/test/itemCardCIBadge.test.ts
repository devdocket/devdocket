// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemCardData } from '../views/mainTypes';

vi.mock('../webview/shared/messaging', () => ({
  postMessage: vi.fn(),
}));

import { postMessage } from '../webview/shared/messaging';
import { ItemCard } from '../webview/sidebar/components/ItemCard';

const item: ItemCardData = {
  id: 'item-1',
  title: 'Watched PR',
  tierType: 'readyToStart',
  badges: [
    { label: 'GitHub', type: 'provider', variant: 'github' },
    { label: '✓ CI passing', type: 'ci', variant: 'ci-pass' },
  ],
  providerId: 'github-pr',
  externalId: 'pr-123',
};

afterEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ItemCard CI badge', () => {
  it('opens the CI Watches panel with the item identity when clicked', () => {
    const onClick = vi.fn();

    render(h(ItemCard, { item, tabIndex: 0, onClick }), document.body);
    const ciBadge = document.body.querySelector('[role="button"]') as HTMLElement | null;
    ciBadge?.click();

    expect(postMessage).toHaveBeenCalledWith({
      type: 'openWatches',
      focusItemId: 'item-1',
      focusProviderId: 'github-pr',
      focusExternalId: 'pr-123',
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('omits provider identity when the item has none (sidebar-only work item)', () => {
    const onClick = vi.fn();
    const localItem: ItemCardData = { ...item, providerId: undefined, externalId: undefined };

    render(h(ItemCard, { item: localItem, tabIndex: 0, onClick }), document.body);
    const ciBadge = document.body.querySelector('[role="button"]') as HTMLElement | null;
    ciBadge?.click();

    expect(postMessage).toHaveBeenCalledWith({ type: 'openWatches', focusItemId: 'item-1' });
  });

  it('lets Tab from the card focus the CI badge before leaving the tier', () => {
    const onMoveTierFocus = vi.fn(() => true);

    render(
      h(ItemCard, { item, tabIndex: 0, onClick: vi.fn(), onMoveTierFocus }),
      document.body,
    );

    const card = document.body.querySelector('[role="option"]') as HTMLElement;
    const ciBadge = document.body.querySelector('[role="button"]') as HTMLElement;
    expect(ciBadge).toBeTruthy();
    expect(ciBadge.tabIndex).toBe(0);

    // Tab from the card itself must NOT preempt browser focus into the
    // badge — otherwise the badge's Enter/Space activation is unreachable.
    const tabFromCard = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    card.dispatchEvent(tabFromCard);
    expect(tabFromCard.defaultPrevented).toBe(false);
    expect(onMoveTierFocus).not.toHaveBeenCalled();

    // Tab from the last focusable descendant (the badge) DOES jump to the next tier.
    const tabFromBadge = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    ciBadge.dispatchEvent(tabFromBadge);
    expect(onMoveTierFocus).toHaveBeenCalledWith(1);
    expect(tabFromBadge.defaultPrevented).toBe(true);
  });
});
