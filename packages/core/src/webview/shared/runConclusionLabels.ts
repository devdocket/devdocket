import type { RunConclusion } from '@devdocket/shared';

export function toConclusionLabel(conclusion?: string): string {
  if (!conclusion) {
    return 'Completed';
  }
  if (conclusion === 'partial_success') {
    return 'Succeeded with issues';
  }
  const label = conclusion.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function toRunCompletionLabel(conclusion?: RunConclusion): string {
  if (!conclusion) {
    return 'completed';
  }
  if (conclusion === 'success') {
    return 'succeeded';
  }
  if (conclusion === 'partial_success') {
    return 'succeeded with issues';
  }
  if (conclusion === 'failure') {
    return 'failed';
  }
  return toConclusionLabel(conclusion);
}

const failedConclusions = new Set(['failure', 'timed_out', 'action_required']);

export function isFailedConclusion(conclusion?: string): boolean {
  return conclusion !== undefined && failedConclusions.has(conclusion);
}
