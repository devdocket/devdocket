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
                {renderActivityDetail(entry, index)}
              </div>
              <span class="activity-entry-time">{formatRelativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function renderActivityDetail(entry: EditorActivityLogEntry, entryIndex: number): VNode | null {
  if (entry.displayDetail) {
    return renderDisplayDetail(entry.displayDetail, entryIndex);
  }
  if (entry.detail) {
    return renderPlainActivityDetail(entry.detail);
  }
  return null;
}

function renderDisplayDetail(display: ActivityDetailRender, entryIndex: number): VNode {
  if (display.kind === 'fields') {
    return (
      <dl class="activity-entry-detail activity-entry-detail--structured">
        {display.rows.map((row, rowIndex) => renderDetailRow(row.label, row.value, entryIndex, rowIndex))}
      </dl>
    );
  }
  return renderPlainActivityDetail(display.text);
}

function renderPlainActivityDetail(detail: string): VNode {
  return <span class="activity-entry-detail">{detail}</span>;
}

function renderDetailRow(label: string, value: string, entryIndex: number, rowIndex: number): VNode {
  // Include both indices so duplicate labels (rare but possible — the API
  // does not require row labels to be unique) cannot collide on the Preact key.
  return (
    <div class="activity-detail-row" key={`${entryIndex}-${rowIndex}-${label}`}>
      <dt class="activity-detail-label">{label}:</dt>
      <dd class="activity-detail-value">{value}</dd>
    </div>
  );
}
