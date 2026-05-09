import type { EditorCIWatchData } from '../../shared/types';

interface CIWatchSectionProps {
  ciWatch?: EditorCIWatchData;
  onOpenWatches: () => void;
}

const MAX_VISIBLE_RUNS = 5;

export function CIWatchSection({ ciWatch, onOpenWatches }: CIWatchSectionProps) {
  if (!ciWatch) {
    return null;
  }

  const visibleRuns = ciWatch.runs.slice(0, MAX_VISIBLE_RUNS);
  const hiddenRunCount = ciWatch.runs.length - visibleRuns.length;

  return (
    <section class="editor-section ci-watch-section" aria-labelledby="editor-ci-watch-heading">
      <div class="ci-watch-heading-row">
        <div class="editor-section-heading" id="editor-ci-watch-heading">CI Watch</div>
        <button
          type="button"
          class="editor-button editor-button--secondary ci-watch-open-button"
          onClick={onOpenWatches}
        >
          Open in CI Watches
        </button>
      </div>
      <div class="ci-watch-run-summary" aria-label="Watched runs">
        {visibleRuns.length > 0 ? visibleRuns.map(run => (
          <span class={`ci-watch-chip ci-watch-chip--${getRunVariant(run)}`} key={`${run.name}-${run.state}-${run.conclusion ?? ''}`}>
            <span aria-hidden="true">{getRunIcon(run)}</span>
            <span>{run.name} ({getRunLabel(run)})</span>
          </span>
        )) : <span class="ci-watch-empty-runs">No active child runs</span>}
        {hiddenRunCount > 0 ? <span class="ci-watch-more">+{hiddenRunCount} more</span> : null}
      </div>
      <div class="ci-watch-aggregate">
        PR state: {ciWatch.state} · {formatCount(ciWatch.totalActive, 'active run')} · {formatCount(ciWatch.totalFailing, 'failing/warning run')}
      </div>
    </section>
  );
}

type CIRun = EditorCIWatchData['runs'][number];

function getRunIcon(run: CIRun): string {
  if (run.hasWarning || isFailedRun(run)) {
    return '⚠';
  }
  if (run.state !== 'completed') {
    return '⏳';
  }
  if (run.conclusion === 'success') {
    return '✓';
  }
  return '○';
}

function getRunVariant(run: CIRun): string {
  if (run.hasWarning || isFailedRun(run)) {
    return 'fail';
  }
  if (run.state !== 'completed') {
    return 'running';
  }
  if (run.conclusion === 'success') {
    return 'pass';
  }
  return 'neutral';
}

function getRunLabel(run: CIRun): string {
  if (run.hasWarning) {
    return 'warning';
  }
  if (run.state === 'queued') {
    return 'queued';
  }
  if (run.state === 'in_progress') {
    return 'in progress';
  }
  return run.conclusion?.replace(/_/g, ' ') ?? 'completed';
}

function isFailedRun(run: CIRun): boolean {
  if (run.state !== 'completed') return false;
  const conclusion = run.conclusion;
  if (conclusion === undefined || conclusion === 'success') return false;
  return conclusion !== 'cancelled' && conclusion !== 'skipped' && conclusion !== 'neutral';
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}
