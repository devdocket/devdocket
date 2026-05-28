import type { ComponentChildren } from 'preact';
import { BadgePill } from '../../shared/components/BadgePill';
import { formatProviderAnnotation } from '../../shared/providerAnnotation';
import type { EditorItemData, GitWorkData } from '../../shared/types';
import { stateLabel, stateTone } from '../editorUtils';
import { isSafeUrl } from '../../../utils/url';

interface EditorHeaderProps {
  item: EditorItemData;
  title: string;
  url?: string;
  onCopyText: (text: string) => void;
  onTitleInput?: (value: string) => void;
  onUrlInput?: (value: string) => void;
  /** Open the worktree associated with this item, when one exists. */
  onOpenWorktree?: () => void;
  /** Action buttons rendered on the right side of the title row (state transitions, run action, etc). */
  actionButtons?: ComponentChildren;
}

export function EditorHeader({ item, title, url = item.url ?? '', onCopyText, onTitleInput, onUrlInput, onOpenWorktree, actionButtons }: EditorHeaderProps) {
  // Always render an <h1> so the page has a primary heading. Editable manual
  // items keep that heading as screen-reader text and place the input beside it
  // in the header, avoiding interactive controls nested inside the heading.
  // When a read-only item has a URL, the heading wraps an anchor so it's still
  // keyboard-activatable and styled as a link.
  //
  // Defense-in-depth: validate the URL with isSafeUrl before binding it
  // to href. The delegated click handler routes through postMessage which
  // re-validates extension-side, but middle-click / right-click / "Copy link"
  // use the raw href and bypass that handler. Fall back to plain text (no
  // anchor) when invalid.
  const safeUrl = url ? isSafeUrl(url) : null;
  const readOnlyTitleContent = safeUrl ? (
    <a class="editor-title-link" href={safeUrl.href}>
      {title}
    </a>
  ) : (
    title
  );
  const titleNode = onTitleInput ? (
    <>
      <h1 class="editor-title editor-title--visually-hidden">{title || 'Untitled work item'}</h1>
      <input
        class="editor-title-input"
        aria-label="Title"
        value={title}
        onInput={event => onTitleInput(event.currentTarget.value)}
      />
    </>
  ) : (
    <h1 class="editor-title">{readOnlyTitleContent}</h1>
  );
  const annotation = formatProviderAnnotation({ source: item.group, author: item.author, authored: item.authored });

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
          {url ? (
            <button
              type="button"
              class="icon-button icon-button--inline"
              aria-label="Copy URL"
              title="Copy URL"
              onClick={() => onCopyText(url)}
            >
              🔗
            </button>
          ) : null}
          {annotation ? (
            <div class="editor-repo-annotation">{annotation}</div>
          ) : null}
          {onUrlInput ? (
            <div class="editor-url-field">
              <span class="editor-url-label">URL</span>
              <input
                class="editor-input editor-url-input"
                type="url"
                aria-label="URL"
                placeholder="https://..."
                value={url}
                onInput={event => onUrlInput(event.currentTarget.value)}
              />
              {safeUrl ? (
                <a class="editor-url-link" href={safeUrl.href}>Open source</a>
              ) : null}
            </div>
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
      {item.gitWork ? (
        <GitWorkRow gitWork={item.gitWork} onOpenWorktree={onOpenWorktree} onCopyText={onCopyText} />
      ) : null}
    </header>
  );
}

function GitWorkRow({
  gitWork,
  onOpenWorktree,
  onCopyText,
}: {
  gitWork: GitWorkData;
  onOpenWorktree?: () => void;
  onCopyText: (text: string) => void;
}) {
  const stale = gitWork.worktreeExists === false;
  return (
    <div
      class={`editor-git-work${stale ? ' editor-git-work--stale' : ''}`}
      role="group"
      aria-label="Associated branch and worktree"
    >
      <span class="editor-git-work-glyph" aria-hidden="true">⎇</span>
      {gitWork.branch ? (
        <span class="editor-git-work-branch" title={`Branch: ${gitWork.branch}`}>
          {gitWork.branch}
        </span>
      ) : null}
      {gitWork.worktreePath ? (
        <span
          class="editor-git-work-path"
          title={stale ? `Worktree (missing): ${gitWork.worktreePath}` : `Worktree: ${gitWork.worktreePath}`}
        >
          {gitWork.worktreePath}
        </span>
      ) : null}
      {stale ? (
        <span class="editor-git-work-stale-label" aria-label="Worktree missing">(missing)</span>
      ) : null}
      {gitWork.worktreePath && onOpenWorktree ? (
        <button
          type="button"
          class="editor-git-work-action"
          onClick={onOpenWorktree}
          title="Open the worktree folder in a new VS Code window"
        >
          Open Worktree
        </button>
      ) : null}
      {gitWork.branch ? (
        <button
          type="button"
          class="icon-button icon-button--inline"
          aria-label="Copy branch name"
          title="Copy branch name"
          onClick={() => onCopyText(gitWork.branch ?? '')}
        >
          ⧉
        </button>
      ) : null}
    </div>
  );
}
