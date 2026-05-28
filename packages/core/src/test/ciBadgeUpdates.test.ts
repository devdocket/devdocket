import { describe, expect, it } from 'vitest';
import type { SourceProviderData, TierData } from '../views/mainTypes';
import { applyCIBadgeChangesToSources, applyCIBadgeChangesToTiers } from '../webview/sidebar/ciBadgeUpdates';

const providerBadge = { label: 'GitHub', type: 'provider' as const, variant: 'github' };
const runningBadge = { label: 'CI running', type: 'ci' as const, variant: 'ci-running' };
const passedBadge = { label: 'CI passed', type: 'ci' as const, variant: 'ci-pass' };

function tier(): TierData {
  return {
    id: 'ready-to-start',
    name: 'Ready to Start',
    icon: '○',
    collapsed: false,
    items: [
      { id: 'one', title: 'Watched item', url: 'https://github.com/org/repo/actions/runs/1', badges: [providerBadge, runningBadge], tierType: 'readyToStart' },
      { id: 'two', title: 'Unwatched item', url: 'https://github.com/org/repo/actions/runs/2', badges: [providerBadge], tierType: 'readyToStart' },
    ],
  };
}

function provider(): SourceProviderData {
  return {
    providerId: 'github',
    label: 'GitHub',
    isHealthy: true,
    groups: [{
      name: 'org/repo',
      items: [
        { providerId: 'github', externalId: '1', title: 'Watched item', url: 'https://github.com/org/repo/actions/runs/1', badges: [providerBadge, runningBadge], isAccepted: true, isDismissed: false },
        { providerId: 'github', externalId: '2', title: 'Unwatched item', url: 'https://github.com/org/repo/actions/runs/2', badges: [providerBadge], isAccepted: false, isDismissed: false },
      ],
    }],
  };
}

describe('CI badge patch helpers', () => {
  it('replaces matching tier card CI badges by URL without touching other cards', () => {
    const source = [tier()];

    const result = applyCIBadgeChangesToTiers(source, [{
      url: 'https://github.com/org/repo/actions/runs/1',
      badge: passedBadge,
    }]);

    expect(result).not.toBe(source);
    expect(result[0].items[0].badges).toEqual([providerBadge, passedBadge]);
    expect(result[0].items[1]).toBe(source[0].items[1]);
  });

  it('removes matching source item CI badges when a watch disappears', () => {
    const source = [provider()];

    const result = applyCIBadgeChangesToSources(source, [{
      url: 'https://github.com/org/repo/actions/runs/1',
      badge: null,
    }]);

    expect(result).not.toBe(source);
    expect(result[0].groups[0].items[0].badges).toEqual([providerBadge]);
    expect(result[0].groups[0].items[1]).toBe(source[0].groups[0].items[1]);
  });
});
