import { BadgePill } from '../../shared/components/BadgePill';
import { formatRelativeTime } from '../../shared/timeUtils';
import type { EditorItemData } from '../../shared/types';
import { stateLabel, stateTone } from '../editorUtils';

interface EditorHeaderProps {
  item: EditorItemData;
  title: string;
  onOpenUrl: (url: string) => void;
}

export function EditorHeader({ item, title, onOpenUrl }: EditorHeaderProps) {
  const metaParts = [
    item.branchName ? `Branch ${item.branchName}` : undefined,
    item.repoName ? `Repo ${item.repoName}` : undefined,
    item.group ? `Group ${item.group}` : undefined,
    `Created ${formatRelativeTime(item.createdAt)}`,
  ].filter((value): value is string => Boolean(value));

  return (
    <header class="editor-header">
      <div class="editor-title-row">
        <div>
          <div class="editor-eyebrow">Work item</div>
          <h1 class="editor-title">{title}</h1>
        </div>
        <div class="editor-title-actions">
          <span class={`editor-status editor-status--${stateTone(item.state)}`}>{stateLabel(item.state)}</span>
          {item.url ? (
            <button
              type="button"
              class="icon-button"
              aria-label="Open item in browser"
              title="Open in browser"
              onClick={() => onOpenUrl(item.url!)}
            >
              ↗
            </button>
          ) : null}
        </div>
      </div>
      <div class="badge-row">
        {item.badges.map(badge => (
          <BadgePill key={`${badge.type}-${badge.variant}-${badge.label}`} badge={badge} />
        ))}
        {item.providerState ? <span class="meta-badge">Provider state · {item.providerState}</span> : null}
      </div>
      <div class="meta-row">
        {metaParts.map(part => (
          <span key={part} class="meta-pill">{part}</span>
        ))}
      </div>
    </header>
  );
}
