import { describe, expect, it } from 'vitest';
import { isFailedConclusion } from '../webview/shared/runConclusionLabels';

describe('runConclusionLabels', () => {
  it('classifies only explicit failure conclusions as failures', () => {
    expect(isFailedConclusion('failure')).toBe(true);
    expect(isFailedConclusion('timed_out')).toBe(true);
    expect(isFailedConclusion('action_required')).toBe(true);

    expect(isFailedConclusion(undefined)).toBe(false);
    expect(isFailedConclusion('success')).toBe(false);
    expect(isFailedConclusion('partial_success')).toBe(false);
    expect(isFailedConclusion('cancelled')).toBe(false);
    expect(isFailedConclusion('skipped')).toBe(false);
    expect(isFailedConclusion('neutral')).toBe(false);
    expect(isFailedConclusion('provider_specific_future_value')).toBe(false);
  });
});
