import type { ComponentChildren } from 'preact';
import { BadgePill } from '../../shared/components/BadgePill';
import { formatRelativeTime } from '../../shared/timeUtils';
import type { EditorItemData } from '../../shared/types';
import { stateLabel, stateTone } from '../editorUtils';

interface EditorHeaderProps {
  item: EditorItemData;
  title: string;
  onOpenUrl: (url: string) => void;
  onCopyText: (text: string) => void;
  /** Action buttons rendered on the right side of the title row (state transitions, run action, etc). */
  actionButtons?: ComponentChildren;
}

export function EditorHeader({ item, title, onOpenUrl, onCopyText, actionButtons }: EditorHeaderProps) {
  const metaParts = [
    item.isIncoming ? undefined : `Created ${formatRelativeTime(item.createdAt)}`,
  ].filter((value): value is string => Boolean(value));

  const titleNode = item.url ? (
    <a
      class="editor-title editor-title--link"
      href={item.url}
      onClick={(event) => {
        event.preventDefault();
        onOpenUrl(item.url!);
      }}
    >
      {title}
    </a>
  ) : (
    <h1 class="editor-title">{title}</h1>
  );

  return (
    <header class="editor-header">
      <div class="editor-title-row">
        <div class="editor-title-block">
          {titleNode}
          <button
            type="button"
            class="icon-button icon-button--inline"
            aria-label="Copy title"
            title="Copy title"
            onClick={() => onCopyText(title)}
          >
            ⧉
          </button>
          {item.url ? (
            <button
              type="button"
              class="icon-button icon-button--inline"
              aria-label="Copy URL"
              title="Copy URL"
              onClick={() => onCopyText(item.url!)}
            >
              🔗
            </button>
          ) : null}
          {item.group ? (
            <div class="editor-repo-annotation">{item.group}</div>
          ) : null}
        </div>
        <div class="editor-title-actions">
          <span class={`editor-status editor-status--${stateTone(item.state)}`}>{stateLabel(item.state)}</span>
        </div>
      </div>
      <div class="editor-pills-actions">
        <div class="editor-pills-stack">
          <div class="badge-row">
            {item.badges.map(badge => (
              <BadgePill key={`${badge.type}-${badge.variant}-${badge.label}`} badge={badge} />
            ))}
            {item.providerState ? <span class="meta-badge">{item.providerState}</span> : null}
          </div>
          <div class="meta-row">
            {metaParts.map(part => (
              <span key={part} class="meta-pill">{part}</span>
            ))}
          </div>
        </div>
        {actionButtons ? <div class="editor-header-actions">{actionButtons}</div> : null}
      </div>
    </header>
  );
}
