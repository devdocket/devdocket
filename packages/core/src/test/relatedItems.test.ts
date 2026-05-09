import { describe, expect, it, vi } from 'vitest';
import type { ProviderItem } from '../api/types';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { buildRelatedItemsIndex, resolveRelatedItemsFor } from '../services/relatedItems';
import { logger } from '../services/logger';

vi.mock('../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

function makeRegistry(discovered: Map<string, ProviderItem[]>) {
  return {
    getAllDiscoveredItems: vi.fn(() => discovered),
  } as any;
}

function makeWorkGraph(items: WorkItem[] = []) {
  return {
    getAll: vi.fn(() => items),
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
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
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
      { targetItemId: 'pr-1', targetTitle: 'Item', targetExternalId: 'owner/repo#10', targetKind: 'workItem', label: 'Linked to Item', relation: 'linked', itemType: 'pr' },
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
        targetTitle: 'Issue',
        targetExternalId: 'owner/repo#2',
        targetKind: 'sources',
        targetProviderId: 'github-issues',
        label: 'Closes Issue',
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
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
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
      'Closes Issue 3',
      'Closes Issue 1',
      'Linked to Issue 2',
      'Linked to Issue 10',
    ]);
  });

  it('is live and does not cache removed refs', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const prDiscovered: ProviderItem = { externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] };
    const discovered = new Map<string, ProviderItem[]>([
      ['github-my-prs', [prDiscovered]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
    ]);
    const registry = makeRegistry(discovered);

    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr]))).toHaveLength(1);
    prDiscovered.relatedItems = [];
    expect(resolveRelatedItemsFor(pr, registry, makeWorkGraph([pr]))).toEqual([]);
  });

  it('indexes forward refs from discovered source items without itemType', () => {
    const source = makeWorkItem({ id: 'source-1', providerId: 'custom-provider', externalId: 'source-with-refs' });
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const registry = makeRegistry(new Map([
      ['custom-provider', [{ externalId: 'source-with-refs', title: 'Source', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'linked' }] }]],
      ['github-issues', [{ externalId: 'owner/repo#2', title: 'Issue', itemType: 'issue' }]],
    ]));

    expect(resolveRelatedItemsFor(source, registry, makeWorkGraph([source, issue]))).toEqual([
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Linked to Item', relation: 'linked', itemType: 'issue' },
    ]);
  });

  it('uses ref itemType when matching discovered targets without itemType', () => {
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'custom-issues', externalId: 'owner/repo#2' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
      ['custom-issues', [{ externalId: 'owner/repo#2', title: 'Issue' }]],
    ]));
    const workGraph = makeWorkGraph([pr, issue]);

    expect(resolveRelatedItemsFor(pr, registry, workGraph)).toEqual([
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
    ]);
    expect(resolveRelatedItemsFor(issue, registry, workGraph)).toEqual([
      { targetItemId: 'pr-1', targetTitle: 'Item', targetExternalId: 'owner/repo#10', targetKind: 'workItem', label: 'Closed by Item', relation: 'closes', itemType: 'pr' },
    ]);
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
      { targetItemId: 'pr-1', targetTitle: 'Item', targetExternalId: 'owner/repo#10', targetKind: 'workItem', label: 'Closed by Item', relation: 'closes', itemType: 'pr' },
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
      { targetItemId: 'accepted-pr', targetTitle: 'Item', targetExternalId: 'owner/repo#10', targetKind: 'workItem', label: 'Linked to Item', relation: 'linked', itemType: 'pr' },
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
    const workGraph = makeWorkGraph([issue, pr]);

    const index = buildRelatedItemsIndex(registry, workGraph);

    expect(resolveRelatedItemsFor(pr, registry, workGraph, index)).toEqual([
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
    ]);
    expect(resolveRelatedItemsFor(issue, registry, workGraph, index)).toEqual([
      { targetItemId: 'pr-1', targetTitle: 'Item', targetExternalId: 'owner/repo#10', targetKind: 'workItem', label: 'Closed by Item', relation: 'closes', itemType: 'pr' },
    ]);
  });

  it('keeps indexed related-item lookups distinct when provenance contains separators', () => {
    const firstPr = makeWorkItem({ id: 'first-pr', providerId: 'github::mentions', externalId: 'owner/repo#10' });
    const secondPr = makeWorkItem({ id: 'second-pr', providerId: 'github', externalId: 'mentions::owner/repo#10' });
    const firstIssue = makeWorkItem({ id: 'first-issue', providerId: 'github-issues', externalId: 'owner/repo#1' });
    const secondIssue = makeWorkItem({ id: 'second-issue', providerId: 'github-issues', externalId: 'owner/repo#2' });
    const registry = makeRegistry(new Map([
      ['github::mentions', [{ externalId: 'owner/repo#10', title: 'First PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#1', itemType: 'issue', relation: 'closes' }] }]],
      ['github', [{ externalId: 'mentions::owner/repo#10', title: 'Second PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
      ['github-issues', [
        { externalId: 'owner/repo#1', title: 'First issue', itemType: 'issue' },
        { externalId: 'owner/repo#2', title: 'Second issue', itemType: 'issue' },
      ]],
    ]));
    const workGraph = makeWorkGraph([firstPr, secondPr, firstIssue, secondIssue]);
    const index = buildRelatedItemsIndex(registry, workGraph);

    expect(resolveRelatedItemsFor(firstPr, registry, workGraph, index)).toEqual([
      { targetItemId: 'first-issue', targetTitle: 'Item', targetExternalId: 'owner/repo#1', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
    ]);
    expect(resolveRelatedItemsFor(secondPr, registry, workGraph, index)).toEqual([
      { targetItemId: 'second-issue', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
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
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
    ]);
    expect(registry.getAllDiscoveredItems).not.toHaveBeenCalled();
  });

  it('falls back to persisted WorkItems when a related target is no longer discovered', () => {
    const issue = makeWorkItem({ id: 'issue-1', providerId: 'github-issues', externalId: 'owner/repo#2', itemType: 'issue' });
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }] }]],
    ]));
    const workGraph = makeWorkGraph([issue, pr]);
    const index = buildRelatedItemsIndex(registry, workGraph);

    expect(resolveRelatedItemsFor(pr, registry, workGraph, index)).toEqual([
      { targetItemId: 'issue-1', targetTitle: 'Item', targetExternalId: 'owner/repo#2', targetKind: 'workItem', label: 'Closes Item', relation: 'closes', itemType: 'issue' },
    ]);
    expect(resolveRelatedItemsFor(issue, registry, workGraph, index)).toEqual([
      { targetItemId: 'pr-1', targetTitle: 'Item', targetExternalId: 'owner/repo#10', targetKind: 'workItem', label: 'Closed by Item', relation: 'closes', itemType: 'pr' },
    ]);
  });

  it('logs strict misses when related refs are not discovered locally', () => {
    vi.mocked(logger.debug).mockClear();
    const pr = makeWorkItem({ id: 'pr-1', providerId: 'github-my-prs', externalId: 'owner/repo#10' });
    const registry = makeRegistry(new Map([
      ['github-my-prs', [{ externalId: 'owner/repo#10', title: 'PR', itemType: 'pr', relatedItems: [{ externalId: 'owner/repo#404', itemType: 'issue', relation: 'closes' }] }]],
    ]));

    buildRelatedItemsIndex(registry, makeWorkGraph([pr]));

    expect(logger.debug).toHaveBeenCalledWith('Resolved 0 / 1 related-item refs (1 dropped because target not in DevDocket)');
  });
});
