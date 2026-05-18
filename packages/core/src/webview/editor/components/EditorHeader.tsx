import type { ComponentChildren } from 'preact';
import { BadgePill } from '../../shared/components/BadgePill';
import type { EditorItemData } from '../../shared/types';
import { stateLabel, stateTone } from '../editorUtils';
import { isSafeUrl } from '../../../utils/url';

interface EditorHeaderProps {
  item: EditorItemData;
  title: string;
  onCopyText: (text: string) => void;
  /** Action buttons rendered on the right side of the title row (state transitions, run action, etc). */
  actionButtons?: ComponentChildren;
}

export function EditorHeader({ item, title, onCopyText, actionButtons }: EditorHeaderProps) {
  // Always render the title inside an <h1> so the page has a primary
  // heading regardless of whether the item has a URL. When url is set,
  // the heading wraps an anchor so it's still keyboard-activatable and
  // styled as a link.
  //
  // Defense-in-depth: validate item.url with isSafeUrl before binding
  // it to href. The delegated click handler routes through postMessage
  // which re-validates extension-side, but middle-click / right-click /
  // "Copy link" use the raw href and bypass that handler. A malicious
  // provider that supplies a `javascript:` URL would otherwise expose
  // the user to a vector that the webview CSP only mitigates rather
  // than blocks. Fall back to plain text (no anchor) when invalid.
  const safeUrl = item.url ? isSafeUrl(item.url) : null;
  const titleContent = safeUrl ? (
    <a class="editor-title-link" href={safeUrl.href}>
      {title}
    </a>
  ) : (
    title
  );
  const titleNode = (
    <h1 class="editor-title">{titleContent}</h1>
  );
  const annotation = getEditorAnnotation(item);

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
          {annotation ? (
            <div class="editor-repo-annotation">{annotation}</div>
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
          </div>
        </div>
        {actionButtons ? <div class="editor-header-actions">{actionButtons}</div> : null}
      </div>
    </header>
  );
}

function getEditorAnnotation(item: EditorItemData): string | undefined {
  const parts = [item.group];
  if (item.author && item.authored !== true) {
    parts.push(item.author.handle ? `@${item.author.handle}` : item.author.displayName);
  }
  return parts.filter((value): value is string => Boolean(value)).join(' · ') || undefined;
}
