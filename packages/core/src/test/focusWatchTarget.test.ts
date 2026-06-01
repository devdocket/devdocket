import { describe, expect, it } from 'vitest';
import { buildFocusWatchTarget, coerceFocusWatchTarget } from '../views/focusWatchTarget';

describe('buildFocusWatchTarget', () => {
  it('returns undefined when no identity is supplied', () => {
    expect(buildFocusWatchTarget({})).toBeUndefined();
    expect(buildFocusWatchTarget({ focusItemId: '' })).toBeUndefined();
    expect(buildFocusWatchTarget({ focusItemId: undefined })).toBeUndefined();
  });

  it('accepts focusItemId alone', () => {
    expect(buildFocusWatchTarget({ focusItemId: 'wi-1' })).toEqual({ focusItemId: 'wi-1' });
  });

  it('requires both focusProviderId and focusExternalId when no focusItemId is set', () => {
    expect(buildFocusWatchTarget({ focusProviderId: 'github-pr' })).toBeUndefined();
    expect(buildFocusWatchTarget({ focusExternalId: 'pr-42' })).toBeUndefined();
    expect(buildFocusWatchTarget({ focusProviderId: 'github-pr', focusExternalId: 'pr-42' })).toEqual({
      focusProviderId: 'github-pr',
      focusExternalId: 'pr-42',
    });
  });

  it('rejects non-string values', () => {
    expect(buildFocusWatchTarget({ focusItemId: 42 as unknown as string })).toBeUndefined();
    expect(buildFocusWatchTarget({ focusItemId: {} as unknown as string })).toBeUndefined();
    expect(buildFocusWatchTarget({
      focusProviderId: 'github-pr',
      focusExternalId: 99 as unknown as string,
    })).toBeUndefined();
  });

  it('combines all three fields when present', () => {
    expect(buildFocusWatchTarget({
      focusItemId: 'wi-1',
      focusProviderId: 'github-pr',
      focusExternalId: 'pr-42',
    })).toEqual({
      focusItemId: 'wi-1',
      focusProviderId: 'github-pr',
      focusExternalId: 'pr-42',
    });
  });

  it('omits empty string fields rather than including them', () => {
    expect(buildFocusWatchTarget({
      focusItemId: 'wi-1',
      focusProviderId: '',
      focusExternalId: '',
    })).toEqual({ focusItemId: 'wi-1' });
  });
});

describe('coerceFocusWatchTarget', () => {
  it('returns undefined for non-object inputs', () => {
    expect(coerceFocusWatchTarget(undefined)).toBeUndefined();
    expect(coerceFocusWatchTarget(null)).toBeUndefined();
    expect(coerceFocusWatchTarget(42)).toBeUndefined();
    expect(coerceFocusWatchTarget('focus')).toBeUndefined();
    expect(coerceFocusWatchTarget(true)).toBeUndefined();
  });

  it('returns undefined for empty objects (so command-palette invocation passes undefined through)', () => {
    expect(coerceFocusWatchTarget({})).toBeUndefined();
  });

  it('passes through valid targets', () => {
    expect(coerceFocusWatchTarget({ focusItemId: 'wi-1' })).toEqual({ focusItemId: 'wi-1' });
    expect(coerceFocusWatchTarget({
      focusProviderId: 'github-pr',
      focusExternalId: 'pr-42',
    })).toEqual({ focusProviderId: 'github-pr', focusExternalId: 'pr-42' });
  });

  it('arrays coerce to no target (no string identity fields)', () => {
    expect(coerceFocusWatchTarget([])).toBeUndefined();
    expect(coerceFocusWatchTarget(['wi-1'])).toBeUndefined();
  });
});
