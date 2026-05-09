import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BadgeData, ExtensionMessage, PRWatchData, RunWatchData } from '../shared/types';
import { postMessage } from '../shared/messaging';
import { BadgePill } from '../shared/components/BadgePill';
import { useThemeChangeCounter } from '../shared/theme';

export function WatchApp() {
  const [prWatches, setPrWatches] = useState<PRWatchData[]>([]);
  const [runWatches, setRunWatches] = useState<RunWatchData[]>([]);
  // Re-render badges when the user switches VS Code theme.
  useThemeChangeCounter();

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      if (message.type === 'updateWatchPanel') {
        setPrWatches(message.prWatches);
        setRunWatches(message.runWatches);
      }
    };

    window.addEventListener('message', handler);
    // Tell the extension we're ready so it can (re)send the initial snapshot.
    // Without this, an updateWatchPanel posted between html-load and listener-
    // attach is lost and the body shows "No active watches" while the title
    // still reflects the extension's count.
    postMessage({ type: 'watchPanelReady' });
    return () => {
      window.removeEventListener('message', handler);
    };
  }, []);

  const completedCount = useMemo(
    () => prWatches.filter(prWatch => prWatch.state !== 'open').length
      + prWatches.reduce((sum, pr) => sum + pr.runs.filter(run => run.state === 'completed').length, 0)
      + runWatches.filter(runWatch => runWatch.state === 'completed').length,
    [prWatches, runWatches],
  );
  const totalCount = prWatches.length + runWatches.length;

  // Flatten PR watches with their child runs into a single ordered list so
  // each row is a top-level item-card (matching the sidebar tier rendering).
  // Children stay adjacent to their parent so the visual grouping is preserved
  // by ordering rather than nesting.
  const prSectionItems = useMemo(() => {
    const items: Array<
      | { kind: 'pr'; pr: PRWatchData }
      | { kind: 'run'; run: RunWatchData; parentTitle: string }
    > = [];
    for (const pr of prWatches) {
      items.push({ kind: 'pr', pr });
      for (const run of pr.runs) {
        items.push({ kind: 'run', run, parentTitle: pr.title });
      }
    }
    return items;
  }, [prWatches]);

  return (
    <div class="watch-panel">
      <header class="watch-header">
        <button
          type="button"
          class="tier-header-action"
          title="Watch a URL"
          aria-label="Watch a URL"
          onClick={() => postMessage({ type: 'addWatchUrl' })}
        >
          + Watch URL
        </button>
        <button
          type="button"
          class="tier-header-action"
          disabled={completedCount === 0}
          title="Dismiss all completed watches"
          aria-label="Dismiss all completed watches"
          onClick={() => postMessage({ type: 'dismissCompletedWatches' })}
        >
          Dismiss Completed
        </button>
      </header>

      {totalCount === 0 ? (
        <div class="empty-state">
          No watches yet. Click <strong>+ Watch URL</strong> above to add a pull request or pipeline run URL.
        </div>
      ) : (
        <div class="tiers">
          {prWatches.length > 0 ? (
            <CollapsibleSection icon="🔀" name="PR Watches" count={prWatches.length}>
              {prSectionItems.map(entry => {
                if (entry.kind === 'pr') {
                  return (
                    <WatchCard
                      key={`pr-${entry.pr.id}`}
                      title={entry.pr.title}
                      meta={entry.pr.repo}
                      preview={entry.pr.errorMessage}
                      previewIsWarning={entry.pr.hasWarning}
                      badge={getPRBadge(entry.pr)}
                      tierClass={getPRTierClass(entry.pr)}
                      url={entry.pr.url}
                      watchId={entry.pr.id}
                      linkedItemId={entry.pr.linkedItemId}
                      linkedSourceKey={entry.pr.linkedSourceKey}
                    />
                  );
                }
                return (
                  <WatchCard
                    key={`run-${entry.run.id}`}
                    title={entry.run.name}
                    meta={`${entry.run.repo} · run on ${entry.parentTitle}`}
                    preview={entry.run.failurePreview}
                    previewIsWarning={entry.run.hasWarning || isFailedRun(entry.run)}
                    badge={getRunBadge(entry.run)}
                    tierClass={getRunTierClass(entry.run)}
                    elapsedTime={entry.run.elapsedTime}
                    url={entry.run.url}
                    watchId={entry.run.id}
                  />
                );
              })}
            </CollapsibleSection>
          ) : null}

          {runWatches.length > 0 ? (
            <CollapsibleSection icon="⚙" name="Run Watches" count={runWatches.length}>
              {runWatches.map(runWatch => (
                <WatchCard
                  key={`standalone-${runWatch.id}`}
                  title={runWatch.name}
                  meta={runWatch.repo}
                  preview={runWatch.failurePreview}
                  previewIsWarning={runWatch.hasWarning || isFailedRun(runWatch)}
                  badge={getRunBadge(runWatch)}
                  tierClass={getRunTierClass(runWatch)}
                  elapsedTime={runWatch.elapsedTime}
                  url={runWatch.url}
                  watchId={runWatch.id}
                />
              ))}
            </CollapsibleSection>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface CollapsibleSectionProps {
  icon: string;
  name: string;
  count: number;
  children: preact.ComponentChildren;
}

function CollapsibleSection({ icon, name, count, children }: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = () => setCollapsed(value => !value);
  return (
    <section class="tier-section">
      <div class="tier-header">
        <button
          type="button"
          class="tier-header-main"
          onClick={toggle}
          aria-expanded={!collapsed}
        >
          <span aria-hidden="true">{icon}</span>
          <span>{name}</span>
          <span class="tier-count">({count})</span>
        </button>
        <button
          type="button"
          class="tier-toggle-button"
          onClick={toggle}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          tabIndex={-1}
        >
          <span class="tier-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
      </div>
      {!collapsed ? <div class="tier-items">{children}</div> : null}
    </section>
  );
}

interface WatchCardProps {
  title: string;
  meta: string;
  preview?: string;
  previewIsWarning?: boolean;
  badge: BadgeData;
  tierClass: string;
  elapsedTime?: string;
  url?: string;
  watchId: string;
  linkedItemId?: string;
  linkedSourceKey?: string;
}

function WatchCard({
  title,
  meta,
  preview,
  previewIsWarning,
  badge,
  tierClass,
  elapsedTime,
  url,
  watchId,
  linkedItemId,
  linkedSourceKey,
}: WatchCardProps) {
  const clickable = Boolean(url);
  const openWatch = () => {
    if (url) {
      postMessage({ type: 'openWatchUrl', url });
    }
  };
  const linkedTargetId = linkedItemId ?? linkedSourceKey;
  const openLinkedItem = () => {
    if (linkedTargetId) {
      postMessage({ type: 'openItem', itemId: linkedTargetId });
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
      class={`item-card item-card--${tierClass}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : -1}
      onClick={openWatch}
      onKeyDown={handleKeyDown}
    >
      <div class="item-card-main">
        <div class="item-line-1">
          <div class="item-title-wrap">
            <span class="item-title">{title}</span>
          </div>
        </div>
        <div class="item-repo-annotation">{meta}</div>
        {preview ? (
          <div class={`watch-row-preview ${previewIsWarning ? 'warning' : ''}`.trim()}>{preview}</div>
        ) : null}
        <div class="badge-row">
          <BadgePill badge={badge} />
          {elapsedTime ? <span class="watch-time">{elapsedTime}</span> : null}
        </div>
      </div>
      <div class="item-actions" role="group" aria-label={`${title} actions`}>
        {linkedTargetId ? (
          <button
            type="button"
            class="item-action-btn"
            title="Open in DevDocket"
            aria-label="Open in DevDocket"
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openLinkedItem();
            }}
          >
            ⇱
          </button>
        ) : null}
        <button
          type="button"
          class="item-action-btn"
          title="Dismiss watch"
          aria-label={`Dismiss ${title}`}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            postMessage({ type: 'dismissWatch', watchId });
          }}
        >
          ✗
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

function getPRTierClass(prWatch: PRWatchData): string {
  switch (prWatch.state) {
    case 'merged': return 'in-progress';
    case 'closed': return 'done';
    default:       return 'incoming';
  }
}

function getRunTierClass(runWatch: RunWatchData): string {
  if (runWatch.hasWarning) {
    return 'paused';
  }
  if (runWatch.state !== 'completed') {
    return 'incoming';
  }
  if (runWatch.conclusion === 'success') {
    return 'in-progress';
  }
  if (runWatch.conclusion === 'cancelled' || runWatch.conclusion === 'skipped' || runWatch.conclusion === 'neutral') {
    return 'done';
  }
  return 'urgent';
}

function isFailedRun(runWatch: RunWatchData): boolean {
  if (runWatch.state !== 'completed') return false;
  const conclusion = runWatch.conclusion;
  if (conclusion === undefined || conclusion === 'success') return false;
  // cancelled / skipped / neutral are explicit non-results, not failures.
  // Mirrors the canonical definition in mainViewProvider.ts so the watch
  // panel webview and the sidebar agree on what counts as a failed run.
  if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') return false;
  return true;
}

function toConclusionLabel(conclusion?: string): string {
  if (!conclusion) {
    return 'Completed';
  }
  return conclusion.replace(/_/g, ' ');
}
