import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BadgeData, ExtensionMessage, PRWatchData, RunWatchData } from '../shared/types';
import { postMessage } from '../shared/messaging';
import { BadgePill } from '../shared/components/BadgePill';

export function WatchApp() {
  const [prWatches, setPrWatches] = useState<PRWatchData[]>([]);
  const [runWatches, setRunWatches] = useState<RunWatchData[]>([]);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      if (message.type === 'updateWatchPanel') {
        setPrWatches(message.prWatches);
        setRunWatches(message.runWatches);
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, []);

  const completedCount = useMemo(
    () => prWatches.filter(prWatch => prWatch.state !== 'open').length
      + runWatches.filter(runWatch => runWatch.state === 'completed').length,
    [prWatches, runWatches],
  );
  const totalCount = prWatches.length + runWatches.length;

  return (
    <div class="watch-panel">
      <header class="watch-header">
        <div class="watch-header-copy">
          <div class="watch-title">CI Watches</div>
          <div class="watch-subtitle">
            {totalCount === 0 ? 'No active watches' : `${totalCount} watch${totalCount === 1 ? '' : 'es'} tracked`}
          </div>
        </div>
        <button
          type="button"
          class="link-button"
          disabled={completedCount === 0}
          onClick={() => postMessage({ type: 'dismissCompletedWatches' })}
        >
          Dismiss All Completed
        </button>
      </header>

      {totalCount === 0 ? (
        <div class="empty-state">Watch a pull request or pipeline run to track it here.</div>
      ) : (
        <div class="watch-sections">
          {prWatches.length > 0 ? (
            <section class="watch-section">
              <div class="watch-section-title">PR Watches</div>
              <div class="watch-list">
                {prWatches.map(prWatch => (
                  <article key={prWatch.id} class="watch-card">
                    <WatchRow
                      title={prWatch.title}
                      icon="🔀"
                      meta={prWatch.repo}
                      preview={prWatch.errorMessage}
                      previewIsWarning={prWatch.hasWarning}
                      badge={getPRBadge(prWatch)}
                      elapsedTime={undefined}
                      url={prWatch.url}
                      watchId={prWatch.id}
                    />
                    {prWatch.runs.length > 0 ? (
                      <div class="watch-children">
                        {prWatch.runs.map(runWatch => (
                          <WatchRow
                            key={runWatch.id}
                            title={runWatch.name}
                            icon={getRunIcon(runWatch)}
                            meta={runWatch.repo}
                            preview={runWatch.failurePreview}
                            previewIsWarning={runWatch.hasWarning || isFailedRun(runWatch)}
                            badge={getRunBadge(runWatch)}
                            elapsedTime={runWatch.elapsedTime}
                            url={runWatch.url}
                            watchId={runWatch.id}
                            nested={true}
                          />
                        ))}
                      </div>
                    ) : (
                      <div class="watch-row watch-empty">No CI runs detected yet.</div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {runWatches.length > 0 ? (
            <section class="watch-section">
              <div class="watch-section-title">Standalone Run Watches</div>
              <div class="watch-list">
                {runWatches.map(runWatch => (
                  <article key={runWatch.id} class="watch-card">
                    <WatchRow
                      title={runWatch.name}
                      icon={getRunIcon(runWatch)}
                      meta={runWatch.repo}
                      preview={runWatch.failurePreview}
                      previewIsWarning={runWatch.hasWarning || isFailedRun(runWatch)}
                      badge={getRunBadge(runWatch)}
                      elapsedTime={runWatch.elapsedTime}
                      url={runWatch.url}
                      watchId={runWatch.id}
                    />
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface WatchRowProps {
  title: string;
  icon: string;
  meta: string;
  preview?: string;
  previewIsWarning?: boolean;
  badge: BadgeData;
  elapsedTime?: string;
  url?: string;
  watchId: string;
  nested?: boolean;
}

function WatchRow({
  title,
  icon,
  meta,
  preview,
  previewIsWarning,
  badge,
  elapsedTime,
  url,
  watchId,
  nested,
}: WatchRowProps) {
  const clickable = Boolean(url);
  const className = ['watch-row', clickable ? 'clickable' : '', nested ? 'watch-child-row' : '']
    .filter(Boolean)
    .join(' ');

  const openWatch = () => {
    if (url) {
      postMessage({ type: 'openWatchUrl', url });
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!clickable) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openWatch();
    }
  };

  return (
    <div
      class={className}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={() => openWatch()}
      onKeyDown={handleKeyDown}
    >
      <div class="watch-row-main">
        <div class="watch-row-top">
          <span class="watch-row-icon" aria-hidden="true">{icon}</span>
          <span class="watch-row-title">{title}</span>
        </div>
        <div class="watch-row-meta">{meta}</div>
        {preview ? (
          <div class={`watch-row-preview ${previewIsWarning ? 'warning' : ''}`.trim()}>{preview}</div>
        ) : null}
      </div>

      <div class="watch-row-actions">
        {elapsedTime ? <span class="watch-time">{elapsedTime}</span> : null}
        <BadgePill badge={badge} />
        <button
          type="button"
          class="icon-button"
          aria-label={`Dismiss ${title}`}
          title="Dismiss watch"
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            postMessage({ type: 'dismissWatch', watchId });
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function getPRBadge(prWatch: PRWatchData): BadgeData {
  switch (prWatch.state) {
    case 'merged':
      return { label: 'Merged', type: 'ci', variant: 'ci-pass' };
    case 'closed':
      return { label: 'Closed', type: 'state', variant: 'closed' };
    default:
      return { label: 'Open', type: 'state', variant: 'open' };
  }
}

function getRunBadge(runWatch: RunWatchData): BadgeData {
  if (runWatch.hasWarning) {
    return { label: 'Warning', type: 'ci', variant: 'ci-fail' };
  }
  if (runWatch.state !== 'completed') {
    return { label: runWatch.state === 'queued' ? 'Queued' : 'Running', type: 'ci', variant: 'ci-running' };
  }
  if (runWatch.conclusion === 'success') {
    return { label: 'Passed', type: 'ci', variant: 'ci-pass' };
  }
  return { label: toConclusionLabel(runWatch.conclusion), type: 'ci', variant: 'ci-fail' };
}

function getRunIcon(runWatch: RunWatchData): string {
  if (runWatch.hasWarning) {
    return '⚠';
  }
  if (runWatch.state === 'queued') {
    return '⏳';
  }
  if (runWatch.state === 'in_progress') {
    return '🔄';
  }
  if (runWatch.conclusion === 'success') {
    return '✓';
  }
  if (runWatch.conclusion === 'cancelled' || runWatch.conclusion === 'skipped') {
    return '⊘';
  }
  return '✗';
}

function isFailedRun(runWatch: RunWatchData): boolean {
  return runWatch.state === 'completed' && runWatch.conclusion !== undefined && runWatch.conclusion !== 'success';
}

function toConclusionLabel(conclusion?: string): string {
  if (!conclusion) {
    return 'Completed';
  }
  return conclusion.replace(/_/g, ' ');
}
