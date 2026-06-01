import { describe, expect, it } from 'vitest';
import { WorkItemState, type WorkItem } from '../models/workItem';
import {
  buildProviderItemMap,
  isUrgentProviderItem,
  sortDoneWorkItems,
  sortPausedWorkItems,
  sortReorderableWorkItems,
  sortReorderBaselineItems,
} from '../views/sidebarOrdering';

function makeWorkItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'item',
    title: 'Item',
    state: WorkItemState.New,
    createdAt: 1,
    updatedAt: 1,
    activityLog: [],
    ...overrides,
  };
}

describe('sidebarOrdering', () => {
  it('sorts reorderable tiers by urgency before manual order and updated time', () => {
    const providerItemMap = buildProviderItemMap(new Map([
      ['github', [
        { externalId: 'urgent', title: 'Urgent', state: 'changes_requested' },
        { externalId: 'ordinary', title: 'Ordinary', state: 'approved' },
      ]],
    ]));
    const items = [
      makeWorkItem({ id: 'ordinary', providerId: 'github', externalId: 'ordinary', sortOrder: 0, updatedAt: 300 }),
      makeWorkItem({ id: 'manual', sortOrder: 1, updatedAt: 200 }),
      makeWorkItem({ id: 'urgent', providerId: 'github', externalId: 'urgent', sortOrder: 99, updatedAt: 100 }),
    ];

    expect(sortReorderableWorkItems(items, providerItemMap).map(item => item.id)).toEqual([
      'urgent',
      'ordinary',
      'manual',
    ]);
  });

  it('keeps drag reorder baseline independent from urgency', () => {
    const items = [
      makeWorkItem({ id: 'urgent', sortOrder: 99, updatedAt: 100 }),
      makeWorkItem({ id: 'ordinary', sortOrder: 0, updatedAt: 300 }),
      makeWorkItem({ id: 'manual', sortOrder: undefined, updatedAt: 400 }),
    ];

    expect(sortReorderBaselineItems(items).map(item => item.id)).toEqual([
      'ordinary',
      'urgent',
      'manual',
    ]);
  });

  it('preserves paused and done tier ordering rules', () => {
    expect(sortPausedWorkItems([
      makeWorkItem({ id: 'newer', updatedAt: 20 }),
      makeWorkItem({ id: 'older', updatedAt: 10 }),
    ]).map(item => item.id)).toEqual(['older', 'newer']);

    expect(sortDoneWorkItems([
      makeWorkItem({ id: 'older', updatedAt: 10 }),
      makeWorkItem({ id: 'newer', updatedAt: 20 }),
    ]).map(item => item.id)).toEqual(['newer', 'older']);
  });

  it('normalizes provider states before checking urgency', () => {
    expect(isUrgentProviderItem({ externalId: '1', title: 'PR', state: ' Changes-Requested ' })).toBe(true);
  });
});
