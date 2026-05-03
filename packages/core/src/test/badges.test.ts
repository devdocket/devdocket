import { describe, expect, it } from 'vitest';
import { buildProviderBadge, buildTypeBadge, buildProviderBadges } from '../views/badges';

describe('buildProviderBadge', () => {
  it('returns Manual for items with no providerId', () => {
    // Manual items (created via Create Work Item) have no providerId.
    // Without a Manual fallback they would show no provider badge at all.
    expect(buildProviderBadge(undefined)).toEqual({ label: 'Manual', type: 'provider', variant: 'manual' });
  });

  it('recognizes any providerId beginning with "github" as GitHub', () => {
    expect(buildProviderBadge('github')).toEqual({ label: 'GitHub', type: 'provider', variant: 'github' });
    expect(buildProviderBadge('github-pr-reviews')).toEqual({ label: 'GitHub', type: 'provider', variant: 'github' });
    expect(buildProviderBadge('github-mentions')).toEqual({ label: 'GitHub', type: 'provider', variant: 'github' });
  });

  it('recognizes any providerId beginning with "ado" as ADO', () => {
    expect(buildProviderBadge('ado')).toEqual({ label: 'ADO', type: 'provider', variant: 'ado' });
    expect(buildProviderBadge('ado-work-items')).toEqual({ label: 'ADO', type: 'provider', variant: 'ado' });
    expect(buildProviderBadge('ado-my-prs')).toEqual({ label: 'ADO', type: 'provider', variant: 'ado' });
  });

  it('does not mis-classify third-party providers whose ids merely contain "github" or "ado"', () => {
    // Substring matching used to mis-label these; prefix matching avoids that.
    expect(buildProviderBadge('my-github-mirror', 'My GitHub Mirror'))
      .toEqual({ label: 'My GitHub Mirror', type: 'provider', variant: 'other' });
    expect(buildProviderBadge('shadow-ado', 'Shadow ADO'))
      .toEqual({ label: 'Shadow ADO', type: 'provider', variant: 'other' });
    expect(buildProviderBadge('avocado', 'Avocado'))
      .toEqual({ label: 'Avocado', type: 'provider', variant: 'other' });
  });

  it('uses the provided label for unknown third-party providers (not "Manual")', () => {
    // Previously, anything that wasn't github/ado was mislabeled as Manual.
    // Third-party providers should now get their real label.
    expect(buildProviderBadge('jira', 'Jira Tickets'))
      .toEqual({ label: 'Jira Tickets', type: 'provider', variant: 'other' });
  });

  it('falls back to the providerId when no label is supplied for an unknown provider', () => {
    expect(buildProviderBadge('linear'))
      .toEqual({ label: 'linear', type: 'provider', variant: 'other' });
  });
});

describe('buildTypeBadge', () => {
  it('returns the Issue badge for itemType=issue', () => {
    expect(buildTypeBadge({ externalId: 'x', title: 'y', itemType: 'issue' }))
      .toEqual({ label: 'Issue', type: 'type', variant: 'issue' });
  });

  it('returns the PR badge for itemType=pr', () => {
    expect(buildTypeBadge({ externalId: 'x', title: 'y', itemType: 'pr' }))
      .toEqual({ label: 'PR', type: 'type', variant: 'pr' });
  });

  it('returns undefined when itemType is unset (e.g. generic / manual items)', () => {
    expect(buildTypeBadge({ externalId: 'x', title: 'y' })).toBeUndefined();
    expect(buildTypeBadge(undefined)).toBeUndefined();
  });
});

describe('buildProviderBadges', () => {
  it('returns an empty array when no badges are declared', () => {
    expect(buildProviderBadges(undefined, 'sidebar')).toEqual([]);
    expect(buildProviderBadges({ externalId: 'x', title: 'y' }, 'sidebar')).toEqual([]);
  });

  it('renders badges with show:both in either view', () => {
    const item = { externalId: 'x', title: 'y', badges: [{ label: 'Mentioned', variant: 'warning' as const }] };
    const sidebar = buildProviderBadges(item, 'sidebar');
    const editor = buildProviderBadges(item, 'editor');
    expect(sidebar).toHaveLength(1);
    expect(editor).toHaveLength(1);
    expect(sidebar[0]).toEqual({ label: 'Mentioned', type: 'provider-supplied', variant: 'review-requested' });
  });

  it('filters badges by their show field', () => {
    const item = {
      externalId: 'x',
      title: 'y',
      badges: [
        { label: 'Sidebar only', variant: 'info' as const, show: 'sidebar' as const },
        { label: 'Editor only', variant: 'info' as const, show: 'editor' as const },
        { label: 'Both', variant: 'info' as const },
      ],
    };
    expect(buildProviderBadges(item, 'sidebar').map(b => b.label)).toEqual(['Sidebar only', 'Both']);
    expect(buildProviderBadges(item, 'editor').map(b => b.label)).toEqual(['Editor only', 'Both']);
  });

  it('maps each variant to its corresponding palette key', () => {
    const item = {
      externalId: 'x',
      title: 'y',
      badges: [
        { label: 'a', variant: 'info' as const },
        { label: 'b', variant: 'success' as const },
        { label: 'c', variant: 'warning' as const },
        { label: 'd', variant: 'danger' as const },
        { label: 'e', variant: 'neutral' as const },
      ],
    };
    expect(buildProviderBadges(item, 'sidebar').map(b => b.variant)).toEqual([
      'open', 'approved', 'review-requested', 'changes-requested', 'neutral',
    ]);
  });
});
