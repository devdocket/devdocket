// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { TierData } from '../webview/shared/types';
import {
  bulkActionHasLanded,
  pickBulkFocusTarget,
  resolveBulkFocusTarget,
  shouldRestoreBulkFocus,
} from '../webview/sidebar/bulkActionFocus';
import type { SelectionState } from '../webview/sidebar/selectionModel';

function makeTier(id: string, itemIds: string[]): TierData {
  return {
    id,
    name: id,
    icon: '○',
    collapsed: false,
    items: itemIds.map(itemId => ({
      id: itemId,
      title: itemId,
      tierType: 'readyToStart',
      badges: [],
    })),
  };
}

function makeSelection(tierId: string, itemIds: string[], anchorId: string): SelectionState {
  return { tierId, itemIds: new Set(itemIds), anchorId };
}

describe('pickBulkFocusTarget', () => {
  it('prefers the focused option if it is part of the selection', () => {
    const tiers = [makeTier('incoming', ['a', 'b', 'c'])];
    const selection = makeSelection('incoming', ['a', 'b'], 'a');
    const focused = document.createElement('div');
    focused.setAttribute('data-item-id', 'b');
    document.body.appendChild(focused);
    try {
      const target = pickBulkFocusTarget(selection, tiers, focused);
      expect(target).toEqual({ itemId: 'b', originTierId: 'incoming' });
    } finally {
      focused.remove();
    }
  });

  it('falls back to the first selected item in tier render order when the focused element is not selected', () => {
    const tiers = [makeTier('incoming', ['x', 'y', 'z'])];
    const selection = makeSelection('incoming', ['z', 'x'], 'z');
    const target = pickBulkFocusTarget(selection, tiers, document.body);
    expect(target).toEqual({ itemId: 'x', originTierId: 'incoming' });
  });

  it('ignores a focused-but-deselected anchor (anchorId outside itemIds)', () => {
    // selectionModel allows ctrl-click toggling off the anchor; the anchor
    // can therefore be a non-selected id. The picker must not return it.
    const tiers = [makeTier('incoming', ['a', 'b'])];
    const selection = makeSelection('incoming', ['b'], 'a');
    const focused = document.createElement('div');
    focused.setAttribute('data-item-id', 'a');
    document.body.appendChild(focused);
    try {
      const target = pickBulkFocusTarget(selection, tiers, focused);
      expect(target).toEqual({ itemId: 'b', originTierId: 'incoming' });
    } finally {
      focused.remove();
    }
  });

  it('returns null when there is no selection', () => {
    expect(pickBulkFocusTarget(null, [], document.body)).toBeNull();
  });

  it('returns null when the origin tier is gone from the snapshot', () => {
    const tiers = [makeTier('ready', ['a'])];
    const selection = makeSelection('incoming', ['a'], 'a');
    expect(pickBulkFocusTarget(selection, tiers, document.body)).toBeNull();
  });

  it('returns null when the selection has no items still in the origin tier', () => {
    const tiers = [makeTier('incoming', ['c'])];
    const selection = makeSelection('incoming', ['a', 'b'], 'a');
    expect(pickBulkFocusTarget(selection, tiers, document.body)).toBeNull();
  });
});

describe('bulkActionHasLanded', () => {
  it('returns false while the target item is still in the origin tier', () => {
    const tiers = [makeTier('incoming', ['a', 'b'])];
    expect(bulkActionHasLanded({ itemId: 'a', originTierId: 'incoming' }, tiers)).toBe(false);
  });

  it('returns true once the target item has left the origin tier', () => {
    const tiers = [
      makeTier('incoming', ['b']),
      makeTier('ready-to-start', ['a']),
    ];
    expect(bulkActionHasLanded({ itemId: 'a', originTierId: 'incoming' }, tiers)).toBe(true);
  });

  it('returns true when the origin tier itself is no longer present', () => {
    const tiers = [makeTier('ready-to-start', ['a'])];
    expect(bulkActionHasLanded({ itemId: 'a', originTierId: 'incoming' }, tiers)).toBe(true);
  });
});

describe('shouldRestoreBulkFocus', () => {
  const pending = { itemId: 'a', originTierId: 'incoming' };

  it('restores when activeElement is document.body', () => {
    expect(shouldRestoreBulkFocus(pending, document.body)).toBe(true);
  });

  it('restores when activeElement is null', () => {
    expect(shouldRestoreBulkFocus(pending, null)).toBe(true);
  });

  it('restores when activeElement is the previously-focused origin item', () => {
    const node = document.createElement('div');
    node.setAttribute('data-item-id', 'a');
    expect(shouldRestoreBulkFocus(pending, node)).toBe(true);
  });

  it('does NOT restore when focus has moved to an unrelated element', () => {
    const node = document.createElement('button');
    expect(shouldRestoreBulkFocus(pending, node)).toBe(false);
  });

  it('does NOT restore when focus is on a different item', () => {
    const node = document.createElement('div');
    node.setAttribute('data-item-id', 'other');
    expect(shouldRestoreBulkFocus(pending, node)).toBe(false);
  });
});

describe('resolveBulkFocusTarget', () => {
  function buildDom(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it('returns the actioned item node when it is present in the DOM', () => {
    const tiers = [makeTier('ready-to-start', ['a'])];
    const root = buildDom('<div data-tier-id="ready-to-start"><button data-tier-header="true"></button><div data-item-id="a" tabindex="0"></div></div>');
    try {
      const target = resolveBulkFocusTarget({ itemId: 'a', originTierId: 'incoming' }, tiers, root);
      expect(target).toBe(root.querySelector('[data-item-id="a"]'));
    } finally {
      root.remove();
    }
  });

  it('falls back to the destination tier header when the item is in the model but not in the DOM', () => {
    const tiers = [makeTier('ready-to-start', ['a'])];
    const root = buildDom('<div data-tier-id="ready-to-start"><button data-tier-header="true"></button></div><div data-tier-id="incoming"><button data-tier-header="true"></button></div>');
    try {
      const target = resolveBulkFocusTarget({ itemId: 'a', originTierId: 'incoming' }, tiers, root);
      expect(target).toBe(root.querySelector('[data-tier-id="ready-to-start"] [data-tier-header="true"]'));
    } finally {
      root.remove();
    }
  });

  it('falls back to the origin tier header when the item is gone entirely', () => {
    const tiers = [makeTier('ready-to-start', [])];
    const root = buildDom('<div data-tier-id="ready-to-start"><button data-tier-header="true"></button></div><div data-tier-id="incoming"><button data-tier-header="true"></button></div>');
    try {
      const target = resolveBulkFocusTarget({ itemId: 'a', originTierId: 'incoming' }, tiers, root);
      expect(target).toBe(root.querySelector('[data-tier-id="incoming"] [data-tier-header="true"]'));
    } finally {
      root.remove();
    }
  });

  it('falls back to the My Work tab as the last resort', () => {
    const tiers: TierData[] = [];
    const root = buildDom('<button id="mission-control-tab-my-work">My Work</button>');
    try {
      const target = resolveBulkFocusTarget({ itemId: 'a', originTierId: 'incoming' }, tiers, root);
      expect(target).toBe(root.querySelector('#mission-control-tab-my-work'));
    } finally {
      root.remove();
    }
  });

  it('handles item ids that contain selector-special characters', () => {
    const tiers = [makeTier('ready', ['github::owner/repo#1'])];
    const root = document.createElement('div');
    const card = document.createElement('div');
    card.setAttribute('data-item-id', 'github::owner/repo#1');
    const tier = document.createElement('div');
    tier.setAttribute('data-tier-id', 'ready');
    tier.appendChild(card);
    root.appendChild(tier);
    document.body.appendChild(root);
    try {
      const target = resolveBulkFocusTarget({ itemId: 'github::owner/repo#1', originTierId: 'incoming' }, tiers, root);
      expect(target).toBe(card);
    } finally {
      root.remove();
    }
  });
});
