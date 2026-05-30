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

  it('returns Accept + Dismiss inbox actions for incoming items', () => {
    const actions = getBulkActionsForItems([item('a', 'incoming'), item('b', 'incoming')]);
    expect(actions.map(a => a.id)).toEqual(['accept', 'dismiss']);
    for (const action of actions) {
      expect(action.kind).toBe('inbox');
    }
  });

  it('returns the tier action set for Ready to Start (start + pause)', () => {
    const actions = getBulkActionsForItems([item('a', 'readyToStart'), item('b', 'readyToStart')]);
    expect(actions.map(a => (a.kind === 'transition' ? a.targetState : undefined))).toEqual(['InProgress', 'Paused']);
  });

  it('returns the tier action set for In Progress (complete + pause)', () => {
    const actions = getBulkActionsForItems([item('a', 'inProgress'), item('b', 'inProgress')]);
    const targets = actions.flatMap(a => (a.kind === 'transition' ? [a.targetState] : []));
    expect(targets.sort()).toEqual(['Done', 'Paused']);
  });

  it('returns the tier action set for Paused (resume)', () => {
    const actions = getBulkActionsForItems([item('a', 'paused')]);
    expect(actions.map(a => (a.kind === 'transition' ? a.targetState : undefined))).toEqual(['InProgress']);
  });

  it('returns the tier action set for Done (requeue)', () => {
    const actions = getBulkActionsForItems([item('a', 'done'), item('b', 'done')]);
    expect(actions.map(a => (a.kind === 'transition' ? a.targetState : undefined))).toEqual(['New']);
  });

  it('returns no actions for a defensive cross-tier mix with disjoint action ids', () => {
    // Multi-select never crosses tiers in normal flow, but if upstream ever
    // produced a mixed list we want a safe answer: 'incoming' actions
    // (accept, dismiss) share no ids with 'readyToStart' (start, pause).
    expect(getBulkActionsForItems([item('a', 'incoming'), item('b', 'readyToStart')])).toEqual([]);
    expect(getBulkActionsForItems([item('a', 'readyToStart'), item('b', 'incoming')])).toEqual([]);
  });

  it('returns the intersection (by action id) if items somehow span actionable tiers', () => {
    // readyToStart actions = [start, pause]; inProgress actions = [complete, pause].
    // Shared action id 'pause' (targetState Paused), so the intersection is just pause.
    const actions = getBulkActionsForItems([item('a', 'readyToStart'), item('b', 'inProgress')]);
    expect(actions.map(a => a.id)).toEqual(['pause']);
  });
});
