import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredItem } from '../api/types';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { buildRelatedItemsIndex, resolveRelatedItemsFor } from '../services/relatedItems';
import { initLogger } from '../services/logger';

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Item',
    state: WorkItemState.New,
    createdAt: now,
    updatedAt: now,
    activityLog: [],
    ...overrides,
  };
}

function makeRegistry(discovered: Map<string, DiscoveredItem[]>) {
  return {
    getAllDiscoveredItems: vi.fn(() => discovered),
  } as any;
}

function makeWorkGraph(items: WorkItem[] = []) {
  return {
    findItemByProvenance: vi.fn((providerId: string, externalId: string) => items.find(
      item => item.providerId === providerId && item.externalId === externalId,
    )),
  } as any;
}

describe('resolveRelatedItemsFor', () => {
  it('resolves forward refs to matching work items', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
    ]));

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr, issue]))).toEqual([
      { targetItemId: 'issue-1', targetKind: 'workItem', label: 'Closes owner/repo#2', relation: 'closes', itemType: 'issue' },
    ]);
  });

  it('resolves reverse refs from issues back to PRs', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'linked' }] }]],
    ]));

    expect(resolveRelatedItemsFor(issue, registry, makeWorkGraph([issue, pr]))).toEqual([
      { targetItemId: 'pr-1', targetKind: 'workItem', label: 'Linked to owner/repo#10', relation: 'linked', itemType: 'pr' },
    ]);
  });

  it('falls back to Sources when the discovered target has no WorkItem', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
    ]));

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr]))).toEqual([
      {
        targetItemId: 'sources:["github-issues","owner/repo#2"]',
        targetKind: 'sources',
        targetProviderId: 'github-issues',
        targetExternalId: 'owner/repo#2',
        label: 'Closes owner/repo#2',
        relation: 'closes',
        itemType: 'issue',
      },
    ]);
  });

  it('prefers a discovered target that maps to a WorkItem over an earlier Sources match', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
      ['github-mentions', [{ externalId: 'owner/repo#2', title: 'Mentioned issue', itemType: 'issue' }]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Assigned issue', itemType: 'issue' }]],
    ]));

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr, issue]))).toEqual([
      { targetItemId: 'issue-1', targetKind: 'workItem', label: 'Closes owner/repo#2', relation: 'closes', itemType: 'issue' },
    ]);
  });

  it('drops strict misses when no provider has discovered the other side', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#404', itemType: 'issue', relation: 'closes' }] }]],
    ]));

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr]))).toEqual([]);
  });

  it('sorts closes before linked and sorts owner/repo numbers numerically', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#100' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{
        externalId: 'owner/repo#100',
        title: 'PR',
        itemType: 'pr',
        relatedItems: [
          { externalId: 'owner/repo#10', itemType: 'issue', relation: 'linked' },
          { externalId: 'owner/repo#2', itemType: 'issue', relation: 'linked' },
          { externalId: 'alpha/repo#3', itemType: 'issue', relation: 'closes' },
          { externalId: 'owner/repo#1', itemType: 'issue', relation: 'closes' },
        ],
      }]],
      ['github-issues', [
        { externalId: 'owner/repo#10', title: 'Issue 10', itemType: 'issue' },
        { externalId: 'owner/repo#2', title: 'Issue 2', itemType: 'issue' },
        { externalId: 'alpha/repo#3', title: 'Issue 3', itemType: 'issue' },
        { externalId: 'owner/repo#1', title: 'Issue 1', itemType: 'issue' },
      ]],
    ]));

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr])).map(item => item.label)).toEqual([
      'Closes alpha/repo#3',
      'Closes owner/repo#1',
      'Linked to owner/repo#2',
      'Linked to owner/repo#10',
    ]);
  });

  it('is live and does not cache removed refs', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const prDiscovered: DiscoveredItem = { externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] };
    const discovered = new Map<string, DiscoveredItem[]>([
      ['github-my-prs', [prDiscovered]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
    ]);
    const registry = makeRegistry(discovered);

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr]))).toHaveLength(1);
    prDiscovered.relatedItems = [];
    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr]))).toEqual([]);
  });

  it('resolves mixed issue providers by itemType and externalId', () => {
    const issueMention = makeWorkItem({ id: 'mention-issue', providerId: 'github-mentions', externalId: 'owner/repo#2' });
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-mentions', [{ externalId: 'owner/repo#2', title: 'Mentioned issue', itemType: 'issue' }]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Assigned issue', itemType: 'issue' }]],
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
    ]));

    expect(resolveRelatedItemsFor(issueMention, registry, makeWorkGraph([issueMention, pr]))).toEqual([
      { targetItemId: 'pr-1', targetKind: 'workItem', label: 'Closed by owner/repo#10', relation: 'closes', itemType: 'pr' },
    ]);
  });

  it('dedupes duplicate related items by type and externalId and prefers WorkItems', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const acceptedPr = makeWorkItem({ id: 'accepted-pr', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
      ['github-pr-review', [{ externalId: 'owner/repo#10', title: 'Review PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'linked' }] }]],
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'My PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'linked' }] }]],
    ]));

    expect(resolveRelatedItemsFor(issue, registry, makeWorkGraph([issue, acceptedPr]))).toEqual([
      { targetItemId: 'accepted-pr', targetKind: 'workItem', label: 'Linked to owner/repo#10', relation: 'linked', itemType: 'pr' },
    ]);
  });

  it('does not match refs with the same externalId but a different itemType', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#5' });
    const registry = makeRegistry(new Map([
      ['github-issues', [{ externalId: 'owner/repo#5', title: 'Issue', itemType: 'issue' }]],
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#5', itemType: 'pr', relation: 'closes' }] }]],
    ]));

    expect(resolveRelatedItemsFor(issue, registry, makeWorkGraph([issue]))).toEqual([]);
  });

  it('builds an indexed related-item lookup for each discovered item', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
    ]));

    const index = buildRelatedItemsIndex(registry, makeWorkGraph([issue, pr]));

    expect(index.get('github-my-prs::owner/repo#10')).toEqual([
      { targetItemId: 'issue-1', targetKind: 'workItem', label: 'Closes owner/repo#2', relation: 'closes', itemType: 'issue' },
    ]);
    expect(index.get('github-issues::owner/repo#2')).toEqual([
      { targetItemId: 'pr-1', targetKind: 'workItem', label: 'Closed by owner/repo#10', relation: 'closes', itemType: 'pr' },
    ]);
  });

  it('uses a precomputed index without rebuilding from the registry', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
    ]));
    const workGraph = makeWorkGraph([issue, pr]);
    const index = buildRelatedItemsIndex(registry, workGraph);
    registry.getAllDiscoveredItems.mockClear();

    expect(resolveRelatedItemsFor(pr, registry, workGraph, index)).toEqual([
      { targetItemId: 'issue-1', targetKind: 'workItem', label: 'Closes owner/repo#2', relation: 'closes', itemType: 'issue' },
    ]);
    expect(registry.getAllDiscoveredItems).not.toHaveBeenCalled();
  });

  it('falls back to persisted itemType for reverse refs when an indexed WorkItem is no longer discovered', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2', itemType: 'issue' });
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
    ]));
    const workGraph = makeWorkGraph([issue, pr]);
    const index = buildRelatedItemsIndex(registry, workGraph);

    expect(resolveRelatedItemsFor(issue, registry, workGraph, index)).toEqual([
      { targetItemId: 'pr-1', targetKind: 'workItem', label: 'Closed by owner/repo#10', relation: 'closes', itemType: 'pr' },
    ]);
  });

  it('logs strict misses when related refs are not discovered locally', () => {
    const channel = { appendLine: vi.fn() };
    initLogger(channel as any, 0);
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#404', itemType: 'issue', relation: 'closes' }] }]],
    ]));

    buildRelatedItemsIndex(registry, makeWorkGraph([pr]));

    expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[DEBUG] Resolved 0 / 1 related-item refs (1 dropped because target not in DevDocket)'));
  });
});
