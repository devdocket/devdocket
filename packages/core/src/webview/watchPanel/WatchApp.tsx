import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BadgeData, ExtensionMessage, PRWatchData, RunWatchData } from '../shared/types';
import { postMessage, setWebviewState } from '../shared/messaging';
import { BadgePill } from '../shared/components/BadgePill';
import { isFailedConclusion, toConclusionLabel } from '../shared/runConclusionLabels';
import { useThemeChangeCounter } from '../shared/theme';

export function WatchApp() {
  const [prWatches, setPrWatches] = useState<PRWatchData[]>([]);
  const [runWatches, setRunWatches] = useState<RunWatchData[]>([]);
  const [expandedPRRuns, setExpandedPRRuns] = useState<Map<string, boolean>>(() => new Map());
  // Re-render badges when the user switches VS Code theme.
  useThemeChangeCounter();

  useEffect(() => {
    setWebviewState({ version: 1, panel: 'watchPanel' });

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
  const togglePRRuns = (prId: string, currentlyExpanded: boolean) => {
    setExpandedPRRuns(current => {
      const next = new Map(current);
      next.set(prId, !currentlyExpanded);
      return next;
    });
  };

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
              {prWatches.map(prWatch => {
                const summary = summarizeRuns(prWatch.runs);
                const hasRuns = summary.total > 0;
                const explicitExpanded = expandedPRRuns.get(prWatch.id);
                const expanded = explicitExpanded ?? summary.failed > 0;
                const preview = getPRPreview(prWatch, summary);
                return (
                  <WatchCard
                    key={`pr-${prWatch.id}`}
                    title={prWatch.title}
                    meta={prWatch.repo}
                    preview={preview}
                    previewIsWarning={prWatch.hasWarning || summary.failed > 0}
                    summary={hasRuns ? formatRunSummary(summary) : undefined}
                    badge={getPRBadge(prWatch)}
                    tierClass={summary.failed > 0 ? 'urgent' : getPRTierClass(prWatch)}
                    url={prWatch.url}
                    watchId={prWatch.id}
                    linkedItemId={prWatch.linkedItemId}
                    linkedSourceProviderId={prWatch.linkedSourceProviderId}
                    linkedSourceExternalId={prWatch.linkedSourceExternalId}
                    expanded={hasRuns ? expanded : undefined}
                    onToggleExpanded={hasRuns ? () => togglePRRuns(prWatch.id, expanded) : undefined}
                  >
                    {hasRuns ? (
                      <div class="nested-run-list" aria-label={`Runs for ${prWatch.title}`}>
                        {prWatch.runs.map(run => (
                          <WatchCard
                            key={`run-${run.id}`}
                            title={run.name}
                            meta={`${run.repo} · run on ${prWatch.title}`}
                            preview={run.failurePreview}
                            previewIsWarning={run.hasWarning || isFailedRun(run)}
                            badge={getRunBadge(run)}
                            tierClass={getRunTierClass(run)}
                            elapsedTime={run.elapsedTime}
                            url={run.url}
                            watchId={run.id}
                            dismissible={false}
                          />
                        ))}
                      </div>
                    ) : null}
                  </WatchCard>
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
  summary?: string;
  badge: BadgeData;
  tierClass: string;
  elapsedTime?: string;
  url?: string;
  watchId: string;
  linkedItemId?: string;
  linkedSourceProviderId?: string;
  linkedSourceExternalId?: string;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  dismissible?: boolean;
  children?: preact.ComponentChildren;
}

function WatchCard({
  title,
  meta,
  preview,
  previewIsWarning,
  summary,
  badge,
  tierClass,
  elapsedTime,
  url,
  watchId,
  linkedItemId,
  linkedSourceProviderId,
  linkedSourceExternalId,
  expanded,
  onToggleExpanded,
  dismissible = true,
  children,
}: WatchCardProps) {
  const clickable = Boolean(url);
  const openWatch = () => {
    if (url) {
      postMessage({ type: 'openWatchUrl', url });
    }
  };
  const hasLinkedSource = Boolean(linkedSourceProviderId && linkedSourceExternalId);
  const hasLinkedTarget = Boolean(linkedItemId || hasLinkedSource);
  const hasActions = hasLinkedTarget || dismissible;
  const hasDetails = Boolean(onToggleExpanded && children);
  const openLinkedItem = () => {
    if (linkedItemId) {
      postMessage({ type: 'openItem', itemId: linkedItemId });
      return;
    }
    if (linkedSourceProviderId && linkedSourceExternalId) {
      postMessage({
        type: 'openItem',
        itemId: `${linkedSourceProviderId}::${linkedSourceExternalId}`,
        providerId: linkedSourceProviderId,
        externalId: linkedSourceExternalId,
      });
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
      <div class="item-card-row">
        <div class="item-card-main">
          <div class="item-line-1">
            <div class="item-title-wrap">
              {onToggleExpanded ? (
                <button
                  type="button"
                  class="watch-disclosure-button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} runs for ${title}`}
                  aria-expanded={expanded}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleExpanded();
                  }}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                </button>
              ) : null}
              <span class="item-title">{title}</span>
            </div>
          </div>
          <div class="item-repo-annotation">{meta}</div>
          {preview ? (
            <div class={`watch-row-preview ${previewIsWarning ? 'warning' : ''}`.trim()}>{preview}</div>
          ) : null}
          {summary ? <div class="watch-run-summary">{summary}</div> : null}
          <div class="badge-row">
            <BadgePill badge={badge} />
            {elapsedTime ? <span class="watch-time">{elapsedTime}</span> : null}
          </div>
        </div>
        {hasActions ? (
          <div class="item-actions" role="group" aria-label={`${title} actions`}>
            {hasLinkedTarget ? (
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
                <span class="codicon codicon-go-to-file" aria-hidden="true" />
              </button>
            ) : null}
            {dismissible ? (
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
            ) : null}
          </div>
        ) : null}
      </div>
      {hasDetails && expanded ? (
        <div
          class="watch-card-details"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
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
  if (runWatch.conclusion === undefined) {
    return { label: toConclusionLabel(runWatch.conclusion), type: 'ci', variant: 'neutral' };
  }
  if (runWatch.conclusion === 'success') {
    return { label: 'Passed', type: 'ci', variant: 'ci-pass' };
  }
  if (runWatch.conclusion === 'partial_success') {
    return { label: 'Succeeded with issues', type: 'ci', variant: 'ci-warn' };
  }
  if (isFailedConclusion(runWatch.conclusion)) {
    return { label: toConclusionLabel(runWatch.conclusion), type: 'ci', variant: 'ci-fail' };
  }
  return { label: toConclusionLabel(runWatch.conclusion), type: 'ci', variant: 'neutral' };
}

interface RunSummary {
  passed: number;
  partialSuccess: number;
  failed: number;
  running: number;
  other: number;
  total: number;
  failurePreview?: string;
}

function summarizeRuns(runs: RunWatchData[]): RunSummary {
  return runs.reduce<RunSummary>((summary, run) => {
    const runFailed = run.hasWarning || isFailedRun(run);
    if (runFailed) {
      summary.failed += 1;
      summary.failurePreview ??= run.failurePreview;
    } else if (run.state !== 'completed') {
      summary.running += 1;
    } else if (run.conclusion === 'success') {
      summary.passed += 1;
    } else if (run.conclusion === 'partial_success') {
      summary.partialSuccess += 1;
    } else {
      summary.other += 1;
    }
    summary.total += 1;
    return summary;
  }, { passed: 0, partialSuccess: 0, failed: 0, running: 0, other: 0, total: 0 });
}

function formatRunSummary(summary: RunSummary): string {
  const parts = [
    `✓ ${summary.passed} passed`,
    `✗ ${summary.failed} failed`,
    `⏳ ${summary.running} running`,
  ];
  if (summary.partialSuccess > 0) {
    parts.push(`⚠ ${summary.partialSuccess} succeeded with issues`);
  }
  if (summary.other > 0) {
    parts.push(`• ${summary.other} other`);
  }
  return `Checks: ${parts.join(' · ')} (${summary.total} total)`;
}

function getPRPreview(prWatch: PRWatchData, summary: RunSummary): string | undefined {
  if (summary.failurePreview && prWatch.errorMessage) {
    return `${summary.failurePreview} · ${prWatch.errorMessage}`;
  }
  return summary.failurePreview ?? prWatch.errorMessage;
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
  if (runWatch.conclusion === undefined) {
    return 'done';
  }
  if (runWatch.conclusion === 'partial_success') {
    return 'paused';
  }
  if (runWatch.conclusion === 'cancelled' || runWatch.conclusion === 'skipped' || runWatch.conclusion === 'neutral') {
    return 'done';
  }
  return 'urgent';
}

function isFailedRun(runWatch: RunWatchData): boolean {
  if (runWatch.state !== 'completed') return false;
  // Delegate to the shared helper so all CI watch surfaces agree on what counts as a failed run.
  return isFailedConclusion(runWatch.conclusion);
}

