import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { formatRelativeTime } from '../../shared/timeUtils';
import type { EditorItemData } from '../../shared/types';
import { activityTypeLabel } from '../editorUtils';

interface ActivityLogProps {
  entries: EditorItemData['activityLog'];
}

export function ActivityLog({ entries }: ActivityLogProps) {
  const [collapsed, setCollapsed] = useState(true);

  if (entries.length === 0) {
    return null;
  }

  const headingId = 'editor-activity-heading';
  const listId = 'editor-activity-list';

  return (
    <section class="editor-section" aria-labelledby={headingId}>
      <button
        type="button"
        class="editor-section-heading editor-section-heading--toggle"
        id={headingId}
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => setCollapsed(value => !value)}
      >
        <span class="editor-section-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span>Activity</span>
        <span class="editor-section-count">({entries.length})</span>
      </button>
      {!collapsed ? (
        <div class="activity-log" id={listId}>
          {[...entries].reverse().map((entry, index) => (
            <div class="activity-entry" key={`${entry.timestamp}-${entry.type}-${index}`}>
              <div class="activity-entry-main">
                <span class="activity-entry-type">{activityTypeLabel(entry.type)}</span>
                {entry.detail ? renderActivityDetail(entry.type, entry.detail) : null}
              </div>
              <span class="activity-entry-time">{formatRelativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

type ActivityDetailRenderer = (detail: string) => VNode;

const activityDetailRenderers: Partial<Record<string, ActivityDetailRenderer>> = {
  'work-started': renderWorkStartedDetail,
};

function renderActivityDetail(type: string, detail: string): VNode {
  const renderer = activityDetailRenderers[type] ?? renderPlainActivityDetail;
  return renderer(detail);
}

function renderPlainActivityDetail(detail: string): VNode {
  return <span class="activity-entry-detail">{detail}</span>;
}

interface WorkStartedDetail {
  branchName?: string;
  worktreePath?: string;
  repoPath?: string;
}

/**
 * Parse the `'work-started'` activity entry detail for rendering.
 *
 * Must stay in lockstep with the schema owned by
 * `packages/start-git-work/src/workStartedDetail.ts`. When that schema
 * bumps to V2, this version check (and the rendered fields) must be
 * updated in the same change. Unknown versions fall through to the
 * plain JSON rendering so the user still sees the raw payload.
 */
const KNOWN_WORK_STARTED_DETAIL_VERSION = 1;

function parseWorkStartedDetail(raw: string): WorkStartedDetail | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const values = parsed as Record<string, unknown>;

    if (values.v !== undefined && values.v !== KNOWN_WORK_STARTED_DETAIL_VERSION) {
      return undefined;
    }

    const detail: WorkStartedDetail = {};
    if (typeof values.branchName === 'string') {
      detail.branchName = values.branchName;
    }
    if (typeof values.worktreePath === 'string') {
      detail.worktreePath = values.worktreePath;
    }
    if (typeof values.repoPath === 'string') {
      detail.repoPath = values.repoPath;
    }

    return detail.branchName || detail.worktreePath || detail.repoPath ? detail : undefined;
  } catch {
    return undefined;
  }
}

function renderWorkStartedDetail(raw: string): VNode {
  const detail = parseWorkStartedDetail(raw);
  if (!detail) {
    return renderPlainActivityDetail(raw);
  }

  return (
    <dl class="activity-entry-detail activity-entry-detail--structured">
      {detail.branchName ? renderDetailRow('Branch', detail.branchName) : null}
      {detail.worktreePath ? renderDetailRow('Worktree', detail.worktreePath) : null}
      {detail.repoPath ? renderDetailRow('Repo', detail.repoPath) : null}
    </dl>
  );
}

function renderDetailRow(label: string, value: string): VNode {
  return (
    <div class="activity-detail-row" key={label}>
      <dt class="activity-detail-label">{label}:</dt>
      <dd class="activity-detail-value">{value}</dd>
    </div>
  );
}
