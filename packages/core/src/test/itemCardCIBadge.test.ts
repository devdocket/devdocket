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
};

afterEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ItemCard CI badge', () => {
  it('opens the CI Watches panel when clicked', () => {
    const onClick = vi.fn();

    render(h(ItemCard, { item, tabIndex: 0, onClick }), document.body);
    const ciBadge = document.body.querySelector('[role="button"]') as HTMLElement | null;
    ciBadge?.click();

    expect(postMessage).toHaveBeenCalledWith({ type: 'openWatches' });
    expect(onClick).not.toHaveBeenCalled();
  });
});
