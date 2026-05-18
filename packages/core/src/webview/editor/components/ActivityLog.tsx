import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { formatRelativeTime } from '../../shared/timeUtils';
import type { ActivityDetailRender, EditorActivityLogEntry, EditorItemData } from '../../shared/types';
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
                {renderActivityDetail(entry)}
              </div>
              <span class="activity-entry-time">{formatRelativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function renderActivityDetail(entry: EditorActivityLogEntry): VNode | null {
  if (entry.displayDetail) {
    return renderDisplayDetail(entry.displayDetail);
  }
  if (entry.detail) {
    return renderPlainActivityDetail(entry.detail);
  }
  return null;
}

function renderDisplayDetail(display: ActivityDetailRender): VNode {
  if (display.kind === 'fields') {
    return (
      <dl class="activity-entry-detail activity-entry-detail--structured">
        {display.rows.map(row => renderDetailRow(row.label, row.value))}
      </dl>
    );
  }
  return renderPlainActivityDetail(display.text);
}

function renderPlainActivityDetail(detail: string): VNode {
  return <span class="activity-entry-detail">{detail}</span>;
}

function renderDetailRow(label: string, value: string): VNode {
  return (
    <div class="activity-detail-row" key={label}>
      <dt class="activity-detail-label">{label}:</dt>
      <dd class="activity-detail-value">{value}</dd>
    </div>
  );
}
