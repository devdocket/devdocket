import { describe, expect, it } from 'vitest';
import { getBulkActionsForItems } from '../webview/sidebar/bulkActions';
import type { ItemCardData } from '../views/mainTypes';

function item(id: string, tierType: ItemCardData['tierType']): ItemCardData {
  return {
    id,
    title: id,
    tierType,
    badges: [],
  };
}

describe('bulkActions.getBulkActionsForItems', () => {
  it('returns no actions for an empty selection', () => {
    expect(getBulkActionsForItems([])).toEqual([]);
  });

  it('returns no actions for incoming items', () => {
    expect(getBulkActionsForItems([item('a', 'incoming')])).toEqual([]);
  });

  it('returns the tier action set for Ready to Start (start + pause)', () => {
    const actions = getBulkActionsForItems([item('a', 'readyToStart'), item('b', 'readyToStart')]);
    expect(actions.map(a => a.targetState)).toEqual(['InProgress', 'Paused']);
  });

  it('returns the tier action set for In Progress (complete + pause)', () => {
    const actions = getBulkActionsForItems([item('a', 'inProgress'), item('b', 'inProgress')]);
    expect(actions.map(a => a.targetState).sort()).toEqual(['Done', 'Paused']);
  });

  it('returns the tier action set for Paused (resume)', () => {
    const actions = getBulkActionsForItems([item('a', 'paused')]);
    expect(actions.map(a => a.targetState)).toEqual(['InProgress']);
  });

  it('returns the tier action set for Done (requeue)', () => {
    const actions = getBulkActionsForItems([item('a', 'done'), item('b', 'done')]);
    expect(actions.map(a => a.targetState)).toEqual(['New']);
  });

  it('returns no actions when a non-actionable tier (incoming) is mixed in, regardless of order', () => {
    expect(getBulkActionsForItems([item('a', 'incoming'), item('b', 'readyToStart')])).toEqual([]);
    expect(getBulkActionsForItems([item('a', 'readyToStart'), item('b', 'incoming')])).toEqual([]);
  });

  it('returns the intersection (by action id) if items somehow span actionable tiers', () => {
    // Defensive — multi-select never crosses tiers in normal flow, but if
    // upstream ever produces a mixed list we still want a safe answer:
    // readyToStart actions = [start, pause]; inProgress actions = [complete, pause].
    // Shared action id 'pause' (targetState Paused), so the intersection is just pause.
    const actions = getBulkActionsForItems([item('a', 'readyToStart'), item('b', 'inProgress')]);
    expect(actions.map(a => a.id)).toEqual(['pause']);
  });
});
