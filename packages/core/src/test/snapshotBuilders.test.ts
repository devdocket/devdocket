import { describe, expect, it } from 'vitest';
import type { ProviderItem } from '../api/types';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { buildSourcesData } from '../views/sourcesSnapshotBuilder';
import { buildTierData } from '../views/tierSnapshotBuilder';
import type { CIBadgeLookup } from '../views/ciBadgeLookup';

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

function emptyCIBadgeLookup(overrides: Partial<CIBadgeLookup> = {}): CIBadgeLookup {
  return {
    byWorkItemId: new Map(),
    byProviderItemKey: new Map(),
    ...overrides,
  };
}

describe('snapshot builders', () => {
  it('builds incoming tiers from visible provider items with canonical hiding, reverse order, read state, and CI badges', () => {
    const allProviderItems = new Map<string, readonly ProviderItem[]>([
      ['github', [
        { externalId: 'a-keep', title: 'Keep', canonicalId: 'same', itemType: 'pr', state: 'changes requested' },
        { externalId: 'b-duplicate', title: 'Duplicate', canonicalId: 'same', state: 'open' },
        { externalId: 'accepted', title: 'Accepted' },
        { externalId: 'latest', title: 'Latest' },
      ]],
    ]);
    const inboxStates = new Map([['github::accepted', 'accepted']]);
    const tiers = buildTierData({
      allProviderItems,
      getInboxState: (providerId, externalId) => inboxStates.get(`${providerId}::${externalId}`),
      hasRead: key => key === 'github::a-keep',
      getProviderLabel: providerId => providerId,
      getItemsByState: () => [],
      findItemByProvenance: () => undefined,
      relatedItemsIndex: new Map(),
      ciBadgeLookup: emptyCIBadgeLookup({
        byProviderItemKey: new Map([['github::a-keep', { label: '✓ CI passing', type: 'ci', variant: 'ci-pass' }]]),
      }),
    });

    expect(tiers).toHaveLength(1);
    expect(tiers[0].id).toBe('incoming');
    expect(tiers[0].items.map(item => item.title)).toEqual(['Latest', 'Keep']);
    expect(tiers[0].items.find(item => item.title === 'Keep')).toEqual(expect.objectContaining({
      id: 'github::a-keep',
      isUnseen: false,
      providerId: 'github',
      externalId: 'a-keep',
      badges: expect.arrayContaining([
        { label: 'GitHub', type: 'provider', variant: 'github' },
        { label: 'PR', type: 'type', variant: 'pr' },
        { label: '✓ CI passing', type: 'ci', variant: 'ci-pass' },
      ]),
    }));
  });

  it('builds work tiers using display ordering and collapsed Done metadata', () => {
    const workItems = [
      makeWorkItem({ id: 'ordinary', providerId: 'github', externalId: 'ordinary', sortOrder: 0, updatedAt: 30 }),
      makeWorkItem({ id: 'urgent', providerId: 'github', externalId: 'urgent', sortOrder: 99, updatedAt: 10 }),
      makeWorkItem({ id: 'done-old', state: WorkItemState.Done, updatedAt: 1 }),
      makeWorkItem({ id: 'done-new', state: WorkItemState.Archived, updatedAt: 2 }),
    ];
    const allProviderItems = new Map<string, readonly ProviderItem[]>([
      ['github', [
        { externalId: 'ordinary', title: 'Ordinary', state: 'open' },
        { externalId: 'urgent', title: 'Urgent', state: 'changes requested' },
      ]],
    ]);

    const tiers = buildTierData({
      allProviderItems,
      getInboxState: () => 'accepted',
      hasRead: () => false,
      getProviderLabel: providerId => providerId,
      getItemsByState: (...states) => workItems.filter(item => states.includes(item.state)),
      findItemByProvenance: () => undefined,
      relatedItemsIndex: new Map(),
      ciBadgeLookup: emptyCIBadgeLookup(),
    });

    expect(tiers.find(tier => tier.id === 'ready-to-start')?.items.map(item => item.id)).toEqual(['urgent', 'ordinary']);
    expect(tiers.find(tier => tier.id === 'done')).toEqual(expect.objectContaining({
      collapsed: true,
      items: [
        expect.objectContaining({ id: 'done-new' }),
        expect.objectContaining({ id: 'done-old' }),
      ],
    }));
  });

  it('builds Sources grouped by provider health, group name, item title, and inbox state', () => {
    const allProviderItems = new Map<string, readonly ProviderItem[]>([
      ['github', [
        { externalId: 'z', title: 'Zulu', group: 'Beta' },
        { externalId: 'a', title: 'Alpha', group: 'Alpha' },
        { externalId: 'g', title: 'Gamma', group: 'Alpha', badges: [{ label: 'Review requested', variant: 'warning' }] },
      ]],
      ['ado', [
        { externalId: 'a1', title: 'ADO Item', group: 'Backlog' },
      ]],
    ]);
    const states = new Map([
      ['github::a', 'accepted'],
      ['github::g', 'dismissed'],
    ]);

    const providers = buildSourcesData({
      allProviderItems,
      getInboxState: (providerId, externalId) => states.get(`${providerId}::${externalId}`),
      getProviderLabel: providerId => providerId === 'ado' ? 'Azure DevOps' : 'GitHub',
      getProviderHealth: providerId => ({ status: providerId === 'ado' ? 'unhealthy' : 'healthy' }),
      relatedItemsIndex: new Map(),
      ciBadgeLookup: emptyCIBadgeLookup(),
    });

    expect(providers.map(provider => provider.label)).toEqual(['Azure DevOps', 'GitHub']);
    expect(providers[0]).toEqual(expect.objectContaining({ isHealthy: false }));
    expect(providers[1].groups.map(group => group.name)).toEqual(['Alpha', 'Beta']);
    expect(providers[1].groups[0].items.map(item => item.title)).toEqual(['Alpha', 'Gamma']);
    expect(providers[1].groups[0].items[0]).toEqual(expect.objectContaining({ isAccepted: true, isDismissed: false }));
    expect(providers[1].groups[0].items[1]).toEqual(expect.objectContaining({
      isAccepted: false,
      isDismissed: true,
      badges: expect.arrayContaining([{ label: 'Review requested', type: 'provider-supplied', variant: 'review-requested' }]),
    }));
  });
});
