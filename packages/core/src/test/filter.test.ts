import { describe, expect, it } from 'vitest';
import type { SourceProviderData, TierData } from '../views/mainTypes';
import { filterProviders, filterTiers, getGroupTotalCountKey, matchesQuery, splitOnMatches } from '../webview/sidebar/filter';
import { hiddenSearchBoxes, isSearchBoxEffectivelyVisible, type TabQueries } from '../webview/sidebar/searchVisibility';

const badge = { label: 'GitHub', type: 'provider' as const, variant: 'github' };

function tier(overrides: Partial<TierData> = {}): TierData {
  return {
    id: 'ready-to-start',
    name: 'Ready to Start',
    icon: '○',
    collapsed: true,
    items: [
      { id: 'one', title: 'Fix sidebar layout', badges: [badge], tierType: 'readyToStart', repoAnnotation: 'devdocket/devdocket' },
      { id: 'two', title: 'Add pipeline watcher', badges: [], tierType: 'readyToStart', repoAnnotation: 'owner/tools' },
    ],
    ...overrides,
  };
}

function provider(overrides: Partial<SourceProviderData> = {}): SourceProviderData {
  return {
    providerId: 'github',
    label: 'GitHub',
    isHealthy: true,
    groups: [
      {
        name: 'devdocket/devdocket',
        items: [
          { providerId: 'github', externalId: '1', title: 'Fix sidebar layout', badges: [badge], isAccepted: false, isDismissed: false },
          { providerId: 'github', externalId: '2', title: 'Add health indicator', badges: [], isAccepted: true, isDismissed: false },
        ],
      },
      {
        name: 'owner/tools',
        items: [
          { providerId: 'github', externalId: '3', title: 'Improve watcher polling', badges: [], isAccepted: false, isDismissed: true },
        ],
      },
    ],
    ...overrides,
  };
}

describe('matchesQuery', () => {
  it('treats empty and whitespace-only queries as matches', () => {
    expect(matchesQuery('Any text', '')).toBe(true);
    expect(matchesQuery('Any text', '   ')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(matchesQuery('DevDocket Sidebar', 'sidebar')).toBe(true);
    expect(matchesQuery('DevDocket Sidebar', 'DEVDOCKET')).toBe(true);
  });

  it('returns false when the substring is absent', () => {
    expect(matchesQuery('DevDocket Sidebar', 'pipeline')).toBe(false);
  });

  it('handles unicode with normal lower-case matching', () => {
    expect(matchesQuery('Résumé cleanup', 'résumé')).toBe(true);
  });
});

describe('filterTiers', () => {
  it('drops tiers with no matching items', () => {
    const result = filterTiers([tier({ id: 'ready' }), tier({ id: 'done', items: [{ id: 'done-1', title: 'Archive old item', badges: [], tierType: 'done' }] })], 'sidebar');

    expect(result.tiers.map(t => t.id)).toEqual(['ready']);
  });

  it('preserves tier metadata while filtering items', () => {
    const source = tier({ id: 'paused', name: 'Paused', icon: '⏸', collapsed: true });
    const result = filterTiers([source], 'pipeline');

    expect(result.tiers[0]).toMatchObject({ id: 'paused', name: 'Paused', icon: '⏸', collapsed: true });
    expect(result.tiers[0].items.map(item => item.id)).toEqual(['two']);
  });

  it('matches against item title', () => {
    const result = filterTiers([tier()], 'layout');

    expect(result.tiers[0].items.map(item => item.title)).toEqual(['Fix sidebar layout']);
  });

  it('matches against repoAnnotation', () => {
    const result = filterTiers([tier()], 'owner/tools');

    expect(result.tiers[0].items.map(item => item.id)).toEqual(['two']);
  });

  it('matches against author display name and rendered handle', () => {
    const resultByName = filterTiers([tier({
      items: [{ id: 'one', title: 'Fix bug', badges: [], tierType: 'readyToStart', author: { displayName: 'Octo Cat', handle: 'octocat' } }],
    })], 'octo cat');
    const resultByHandle = filterTiers([tier({
      items: [{ id: 'one', title: 'Fix bug', badges: [], tierType: 'readyToStart', author: { displayName: 'Octo Cat', handle: 'octocat' } }],
    })], '@octocat');

    expect(resultByName.tiers[0].items.map(item => item.id)).toEqual(['one']);
    expect(resultByHandle.tiers[0].items.map(item => item.id)).toEqual(['one']);
  });

  it('reports pre-filter total counts', () => {
    const result = filterTiers([tier({ id: 'ready' }), tier({ id: 'done', items: [] })], 'layout');

    expect(result.totalCounts.get('ready')).toBe(2);
    expect(result.totalCounts.get('done')).toBe(0);
  });
});

describe('filterProviders', () => {
  it('drops empty groups and empty providers', () => {
    const result = filterProviders([provider(), provider({ providerId: 'ado', label: 'ADO', groups: [{ name: 'project', items: [{ providerId: 'ado', externalId: '4', title: 'Plan sprint', badges: [], isAccepted: false, isDismissed: false }] }] })], 'watcher');

    expect(result.providers.map(p => p.providerId)).toEqual(['github']);
    expect(result.providers[0].groups.map(group => group.name)).toEqual(['owner/tools']);
  });

  it('surfaces every item in a group when the group name matches', () => {
    const result = filterProviders([provider()], 'devdocket/devdocket');

    expect(result.providers[0].groups[0].items.map(item => item.externalId)).toEqual(['1', '2']);
  });

  it('does not match provider labels', () => {
    const result = filterProviders([provider()], 'github');

    expect(result.providers).toEqual([]);
  });

  it('reports pre-filter total counts for providers and groups', () => {
    const result = filterProviders([provider()], 'layout');

    expect(result.totalCounts.get('github')).toBe(3);
    expect(result.totalCounts.get(getGroupTotalCountKey('github', 'devdocket/devdocket'))).toBe(2);
    expect(result.totalCounts.get(getGroupTotalCountKey('github', 'owner/tools'))).toBe(1);
  });
});

describe('isSearchBoxEffectivelyVisible', () => {
  const empty: TabQueries = { myWork: '', sources: '' };

  it('stays hidden when the toggle is collapsed and queries are empty', () => {
    expect(isSearchBoxEffectivelyVisible('myWork', hiddenSearchBoxes, empty, empty)).toBe(false);
  });

  it('shows when the tab toggle is expanded', () => {
    expect(isSearchBoxEffectivelyVisible('sources', { ...hiddenSearchBoxes, sources: true }, empty, empty)).toBe(true);
  });

  it('auto-shows when a pending or applied query is non-empty', () => {
    expect(isSearchBoxEffectivelyVisible('myWork', hiddenSearchBoxes, { ...empty, myWork: 'review' }, empty)).toBe(true);
    expect(isSearchBoxEffectivelyVisible('sources', hiddenSearchBoxes, empty, { ...empty, sources: 'pipeline' })).toBe(true);
  });
});

describe('splitOnMatches', () => {
  it('returns the original text when there are zero matches', () => {
    expect(splitOnMatches('DevDocket', 'missing')).toEqual([{ text: 'DevDocket', isMatch: false }]);
  });

  it('splits a single match', () => {
    expect(splitOnMatches('DevDocket', 'dock')).toEqual([
      { text: 'Dev', isMatch: false },
      { text: 'Dock', isMatch: true },
      { text: 'et', isMatch: false },
    ]);
  });

  it('splits multiple matches', () => {
    expect(splitOnMatches('foo bar foo', 'foo')).toEqual([
      { text: 'foo', isMatch: true },
      { text: ' bar ', isMatch: false },
      { text: 'foo', isMatch: true },
    ]);
  });

  it('handles matches at the start and end of the string', () => {
    expect(splitOnMatches('start middle start', 'start')).toEqual([
      { text: 'start', isMatch: true },
      { text: ' middle ', isMatch: false },
      { text: 'start', isMatch: true },
    ]);
  });

  it('treats regex-special characters literally', () => {
    expect(splitOnMatches('Find .*\\(value\\) here', '.*\\(value\\)')).toEqual([
      { text: 'Find ', isMatch: false },
      { text: '.*\\(value\\)', isMatch: true },
      { text: ' here', isMatch: false },
    ]);
  });

  it('handles unicode', () => {
    expect(splitOnMatches('Résumé cleanup résumé', 'résumé')).toEqual([
      { text: 'Résumé', isMatch: true },
      { text: ' cleanup ', isMatch: false },
      { text: 'résumé', isMatch: true },
    ]);
  });

  it('keeps original slice positions when lowercase expansion shifts match indexes', () => {
    expect(splitOnMatches('İSTANBUL issue', 'issue')).toEqual([
      { text: 'İSTANBUL ', isMatch: false },
      { text: 'issue', isMatch: true },
    ]);
  });

  it('highlights original text for matches inside lowercase-expanded characters', () => {
    expect(splitOnMatches('İssue', 'i')).toEqual([
      { text: 'İ', isMatch: true },
      { text: 'ssue', isMatch: false },
    ]);
  });
});
