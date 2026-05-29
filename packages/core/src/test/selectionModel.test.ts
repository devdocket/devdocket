import { describe, expect, it } from 'vitest';
import {
  applySelectionClick,
  clearSelection,
  isMultiSelectTier,
  reconcileSelection,
  type SelectionState,
  type TierMembership,
} from '../webview/sidebar/selectionModel';

const tier: TierMembership = {
  tierId: 'ready-to-start',
  itemIds: ['a', 'b', 'c', 'd', 'e'],
};

const otherTier: TierMembership = {
  tierId: 'in-progress',
  itemIds: ['x', 'y'],
};

function ids(state: SelectionState): string[] {
  return state ? Array.from(state.itemIds).sort() : [];
}

describe('selectionModel.applySelectionClick', () => {
  it('plain click selects exactly one item and sets the anchor', () => {
    const next = applySelectionClick(null, 'b', tier, 'none');
    expect(next?.tierId).toBe('ready-to-start');
    expect(next?.anchorId).toBe('b');
    expect(ids(next)).toEqual(['b']);
  });

  it('plain click replaces any existing selection', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'b', 'c']),
      anchorId: 'a',
    };
    const next = applySelectionClick(seed, 'd', tier, 'none');
    expect(ids(next)).toEqual(['d']);
    expect(next?.anchorId).toBe('d');
  });

  it('ctrl/cmd click adds an unselected item to the selection', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a']),
      anchorId: 'a',
    };
    const next = applySelectionClick(seed, 'c', tier, 'toggle');
    expect(ids(next)).toEqual(['a', 'c']);
    expect(next?.anchorId).toBe('c');
  });

  it('ctrl/cmd click removes an already-selected item', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'b']),
      anchorId: 'b',
    };
    const next = applySelectionClick(seed, 'a', tier, 'toggle');
    expect(ids(next)).toEqual(['b']);
  });

  it('ctrl/cmd click that empties the selection returns null', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a']),
      anchorId: 'a',
    };
    const next = applySelectionClick(seed, 'a', tier, 'toggle');
    expect(next).toBeNull();
  });

  it('ctrl/cmd click on a different tier replaces the whole selection', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'b']),
      anchorId: 'b',
    };
    const next = applySelectionClick(seed, 'x', otherTier, 'toggle');
    expect(next?.tierId).toBe('in-progress');
    expect(ids(next)).toEqual(['x']);
  });

  it('shift click range-extends from the anchor (forward)', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['b']),
      anchorId: 'b',
    };
    const next = applySelectionClick(seed, 'd', tier, 'range');
    expect(ids(next)).toEqual(['b', 'c', 'd']);
    // Anchor stays on the original click, so users can keep shift-clicking
    // to widen or shrink the range from the same point.
    expect(next?.anchorId).toBe('b');
  });

  it('shift click range-extends from the anchor (backward)', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['d']),
      anchorId: 'd',
    };
    const next = applySelectionClick(seed, 'a', tier, 'range');
    expect(ids(next)).toEqual(['a', 'b', 'c', 'd']);
    expect(next?.anchorId).toBe('d');
  });

  it('shift click without an existing selection falls back to plain select', () => {
    const next = applySelectionClick(null, 'c', tier, 'range');
    expect(ids(next)).toEqual(['c']);
  });

  it('shift click whose target id is missing from the tier falls back to plain select', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['b']),
      anchorId: 'b',
    };
    const next = applySelectionClick(seed, 'zz', tier, 'range');
    expect(ids(next)).toEqual(['zz']);
  });

  it('shift click whose anchor has been removed from the tier falls back to plain select', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['zz']),
      anchorId: 'zz',
    };
    const next = applySelectionClick(seed, 'c', tier, 'range');
    expect(ids(next)).toEqual(['c']);
  });
});

describe('selectionModel.clearSelection', () => {
  it('returns null', () => {
    expect(clearSelection()).toBeNull();
  });
});

describe('selectionModel.reconcileSelection', () => {
  it('returns null if the tier is gone', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'b']),
      anchorId: 'a',
    };
    expect(reconcileSelection(seed, undefined)).toBeNull();
  });

  it('drops items that are no longer in the tier', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'b', 'c']),
      anchorId: 'b',
    };
    const next = reconcileSelection(seed, { tierId: 'ready-to-start', itemIds: ['a', 'c'] });
    expect(ids(next)).toEqual(['a', 'c']);
  });

  it('moves the anchor to the first remaining selected id if the original anchor was removed', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'c']),
      anchorId: 'b',
    };
    const next = reconcileSelection(seed, { tierId: 'ready-to-start', itemIds: ['a', 'c'] });
    expect(next?.anchorId).toBe('a');
  });

  it('returns null when nothing is left selected', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a']),
      anchorId: 'a',
    };
    const next = reconcileSelection(seed, { tierId: 'ready-to-start', itemIds: ['b', 'c'] });
    expect(next).toBeNull();
  });

  it('returns the same reference when nothing changed', () => {
    const seed: SelectionState = {
      tierId: 'ready-to-start',
      itemIds: new Set(['a', 'c']),
      anchorId: 'a',
    };
    const next = reconcileSelection(seed, { tierId: 'ready-to-start', itemIds: ['a', 'b', 'c', 'd'] });
    // Referential equality matters: callers feed this into Preact state and
    // a new object would cause redundant rerenders on every tier update.
    expect(next).toBe(seed);
  });
});

describe('selectionModel.isMultiSelectTier', () => {
  it('returns true for incoming and the four work-item tiers', () => {
    for (const tierId of ['incoming', 'ready-to-start', 'in-progress', 'paused', 'done']) {
      expect(isMultiSelectTier(tierId)).toBe(true);
    }
  });

  it('returns false for unknown tier ids', () => {
    expect(isMultiSelectTier('sources')).toBe(false);
    expect(isMultiSelectTier('unknown')).toBe(false);
  });
});
