import { formatRelativeTime } from '../../shared/timeUtils';
import type { EditorItemData } from '../../shared/types';
import { activityTypeLabel } from '../editorUtils';

interface ActivityLogProps {
  entries: EditorItemData['activityLog'];
}

export function ActivityLog({ entries }: ActivityLogProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section class="editor-section" aria-labelledby="editor-activity-heading">
      <div class="editor-section-heading" id="editor-activity-heading">Activity</div>
      <div class="activity-log">
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
    </section>
  );
}
