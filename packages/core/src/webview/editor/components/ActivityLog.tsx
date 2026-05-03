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
                {entry.detail ? <span class="activity-entry-detail">{entry.detail}</span> : null}
              </div>
              <span class="activity-entry-time">{formatRelativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
