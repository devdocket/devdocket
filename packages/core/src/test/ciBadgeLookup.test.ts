import { describe, expect, it } from 'vitest';
import type { ProviderItem } from '../api/types';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { buildCIBadgeLookup, type CIBadgeWatcherService } from '../views/ciBadgeLookup';
import { getProviderItemKey } from '../views/providerItemKey';
import type { WatchedPR, WatchedRun } from '../services/watcherService';
import type { PRIdentifier } from '@devdocket/shared';

function makePRWorkItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'wi',
    title: 'PR',
    state: WorkItemState.New,
    createdAt: 1,
    updatedAt: 1,
    activityLog: [],
    itemType: 'pr',
    ...overrides,
  };
}

function makePRIdentifier(repo: string, prId: string): PRIdentifier {
  return { providerId: 'github-pr', prId, repo, displayName: `PR ${prId}`, url: '' };
}

function makeWatchedPR(identifier: PRIdentifier): WatchedPR {
  return {
    identifier,
    prState: { state: 'open' as const, title: identifier.displayName, isDraft: false, mergeable: 'unknown' },
    childRunKeys: [],
    watchedAt: '2025-01-01T00:00:00Z',
    lastPolledAt: '2025-01-01T00:00:00Z',
    dismissed: false,
  } as unknown as WatchedPR;
}

function makeRun(overallState: 'queued' | 'in_progress' | 'completed', conclusion?: string, opts: Partial<WatchedRun> = {}): WatchedRun {
  return {
    identifier: { providerId: 'github-actions', runId: 'r', displayName: 'r', url: '' },
    status: { overallState, conclusion, jobs: [] } as never,
    watchedAt: '2025-01-01T00:00:00Z',
    lastPolledAt: '2025-01-01T00:00:00Z',
    dismissed: false,
    ...opts,
  };
}

function makeWatcher(opts: {
  prs?: WatchedPR[];
  runsByKey?: Record<string, WatchedRun[]>;
}): CIBadgeWatcherService {
  return {
    getActivePRWatches: () => opts.prs ?? [],
    getPRWatchKey: identifier => `${identifier.providerId}::${identifier.repo}#${identifier.prId}`,
    getChildRuns: key => opts.runsByKey?.[key] ?? [],
  };
}

describe('buildCIBadgeLookup', () => {
  it('returns an empty lookup when there are no active PR watches', () => {
    const result = buildCIBadgeLookup([], new Map(), makeWatcher({}));
    expect(result.byWorkItemId.size).toBe(0);
    expect(result.byProviderItemKey.size).toBe(0);
  });

  it('skips non-PR work items and non-PR provider items', () => {
    const workItems: WorkItem[] = [
      makePRWorkItem({ id: 'pr-wi', providerId: 'github-my-prs', externalId: 'octo/repo#1', itemType: undefined }),
      makePRWorkItem({ id: 'issue-wi', providerId: 'github-my-issues', externalId: 'octo/repo#2', itemType: 'issue' }),
    ];
    const providerItems = new Map<string, ProviderItem[]>([
      ['github-my-prs', [{ externalId: 'octo/repo#1', title: 'PR 1' }]],
      ['github-my-issues', [{ externalId: 'octo/repo#2', title: 'Issue 2', itemType: 'issue' }]],
    ]);
    const identifier = makePRIdentifier('octo/repo', '1');
    const key = `${identifier.providerId}::${identifier.repo}#${identifier.prId}`;
    const lookup = buildCIBadgeLookup(workItems, providerItems, makeWatcher({
      prs: [makeWatchedPR(identifier)],
      runsByKey: { [key]: [makeRun('completed', 'success')] },
    }));

    expect(lookup.byWorkItemId.has('pr-wi')).toBe(true);
    expect(lookup.byWorkItemId.has('issue-wi')).toBe(false);
    expect(lookup.byProviderItemKey.has(getProviderItemKey('github-my-prs', 'octo/repo#1'))).toBe(true);
    expect(lookup.byProviderItemKey.has(getProviderItemKey('github-my-issues', 'octo/repo#2'))).toBe(false);
  });

  it('omits entries for PR watches whose runs produce no badge', () => {
    const identifier = makePRIdentifier('octo/repo', '1');
    const key = `${identifier.providerId}::${identifier.repo}#${identifier.prId}`;
    const workItems: WorkItem[] = [
      makePRWorkItem({ id: 'wi-1', providerId: 'github-my-prs', externalId: 'octo/repo#1' }),
    ];
    const lookup = buildCIBadgeLookup(workItems, new Map(), makeWatcher({
      prs: [makeWatchedPR(identifier)],
      runsByKey: { [key]: [] },
    }));

    expect(lookup.byWorkItemId.size).toBe(0);
    expect(lookup.byProviderItemKey.size).toBe(0);
  });

  it('fans the same badge out to multiple work items sharing an externalId', () => {
    const identifier = makePRIdentifier('octo/repo', '7');
    const key = `${identifier.providerId}::${identifier.repo}#${identifier.prId}`;
    const workItems: WorkItem[] = [
      makePRWorkItem({ id: 'wi-a', providerId: 'github-my-prs', externalId: 'octo/repo#7' }),
      makePRWorkItem({ id: 'wi-b', providerId: 'github-pr-reviews', externalId: 'octo/repo#7' }),
    ];
    const lookup = buildCIBadgeLookup(workItems, new Map(), makeWatcher({
      prs: [makeWatchedPR(identifier)],
      runsByKey: { [key]: [makeRun('completed', 'failure')] },
    }));

    expect(lookup.byWorkItemId.get('wi-a')?.variant).toBe('ci-fail');
    expect(lookup.byWorkItemId.get('wi-b')?.variant).toBe('ci-fail');
  });

  it('maps both GitHub-style and ADO-style externalId encodings to provider item keys', () => {
    const githubId = makePRIdentifier('octo/repo', '11');
    const adoId = makePRIdentifier('org/proj/repo', '22');
    const ghKey = `${githubId.providerId}::${githubId.repo}#${githubId.prId}`;
    const adoKey = `${adoId.providerId}::${adoId.repo}#${adoId.prId}`;
    const providerItems = new Map<string, ProviderItem[]>([
      ['github-my-prs', [{ externalId: 'octo/repo#11', title: 'GH' }]],
      ['ado-my-prs', [{ externalId: 'org/proj/repo/22', title: 'ADO' }]],
    ]);
    const lookup = buildCIBadgeLookup([], providerItems, makeWatcher({
      prs: [makeWatchedPR(githubId), makeWatchedPR(adoId)],
      runsByKey: {
        [ghKey]: [makeRun('in_progress')],
        [adoKey]: [makeRun('completed', 'success')],
      },
    }));

    expect(lookup.byProviderItemKey.get(getProviderItemKey('github-my-prs', 'octo/repo#11'))?.variant).toBe('ci-running');
    expect(lookup.byProviderItemKey.get(getProviderItemKey('ado-my-prs', 'org/proj/repo/22'))?.variant).toBe('ci-pass');
  });
});
