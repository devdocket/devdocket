import * as crypto from 'crypto';
import { WorkItem, WorkItemState } from '../models/workItem';

export interface EditorHtmlOptions {
  cspSource: string;
  item: WorkItem;
  /** Display label for the provider, shown only when item.providerId is set. */
  providerLabel?: string;
  /** Read-only description from the provider. Will be HTML-escaped before rendering. */
  providerDescription?: string;
  /** When true, the title field is read-only (managed by a live provider). */
  titleReadonly?: boolean;
}

export function getEditorPanelHtml({ cspSource, item, providerLabel, providerDescription, titleReadonly }: EditorHtmlOptions): string {
  const nonce = getNonce();
  const descriptionSection = providerDescription
    ? `    <div class="field">
      <label id="provider-desc-label">Provider Description</label>
      <div class="provider-description" role="note" aria-labelledby="provider-desc-label">${escapeHtml(providerDescription)}</div>
    </div>`
    : '';
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, transparent);
      --font: var(--vscode-font-family, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      font-size: var(--font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px min(5%, 24px);
      max-width: min(560px, 100%);
      margin: 0 auto;
    }
    h2 {
      font-size: 1.2em;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .field {
      margin-bottom: 14px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 4px;
      font-size: 0.9em;
    }
    input, textarea {
      width: 100%;
      padding: 6px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      font-family: var(--font);
      font-size: var(--font-size);
      outline: none;
    }
    input:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    textarea {
      min-height: 80px;
      resize: vertical;
    }
    .row {
      display: flex;
      gap: 12px;
    }
    .row .field {
      flex: 1;
    }
    input[readonly], textarea[readonly] {
      color: var(--vscode-disabledForeground, var(--vscode-foreground));
      cursor: text;
      border-style: dashed;
      background-color: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.15));
    }
    .hint {
      font-size: 0.8em;
      opacity: 0.6;
      margin-top: 2px;
      display: block;
    }
    .metadata {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--input-border);
    }
    .metadata-heading {
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.7;
      margin-bottom: 10px;
    }
    .metadata dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 16px;
      align-items: baseline;
      margin: 0;
    }
    .metadata dt {
      font-size: 0.85em;
      opacity: 0.7;
    }
    .metadata dd {
      font-size: 0.85em;
      margin: 0;
    }
    .badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      font-weight: 500;
    }
    .badge-new {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badge-inprogress {
      background: var(--vscode-terminal-ansiGreen, #388a34);
      color: #fff;
    }
    .badge-paused {
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: #000;
    }
    .badge-done {
      background: var(--vscode-testing-iconPassed, #73c991);
      color: #000;
    }
    .badge-archived {
      background: var(--vscode-disabledForeground, #888);
      color: #fff;
    }
    .provider-description {
      padding: 8px 10px;
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
      background: var(--vscode-textBlockQuote-background, var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08)));
      font-style: italic;
      white-space: pre-wrap;
      margin-top: 2px;
    }
    .title-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .title-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h2 id="editor-heading">${item.url ? `<a class="title-link" id="title-link" data-url="${escapeAttr(item.url)}">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h2>
  <div id="form" role="form" aria-labelledby="editor-heading">
    <div class="field">
      <label for="title">Title</label>
      <input type="text" id="title" value="${escapeAttr(item.title)}" ${titleReadonly ? 'readonly aria-readonly="true" aria-describedby="readonly-title-hint"' : ''} />
${titleReadonly ? '      <span id="readonly-title-hint" class="hint">Title is managed by the provider</span>' : ''}
    </div>
${descriptionSection}
    <div class="field">
      <label for="notes">Notes</label>
      <textarea id="notes" placeholder="Add notes...">${escapeHtml(item.notes ?? '')}</textarea>
    </div>
  </div>
  <div class="metadata" aria-label="Item metadata">
    <div class="metadata-heading">Details</div>
    <dl>
      <dt>State</dt>
      <dd><span class="badge ${stateBadgeClass(item.state)}">${escapeHtml(stateLabel(item.state))}</span></dd>
${item.providerId && providerLabel ? `      <dt>Provider</dt>
      <dd>${escapeHtml(providerLabel)}</dd>` : ''}
      <dt>Created</dt>
      <dd>${escapeHtml(formatTimestamp(item.createdAt))}</dd>
      <dt>Updated</dt>
      <dd>${escapeHtml(formatTimestamp(item.updatedAt))}</dd>
    </dl>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fields = ['title', 'notes'];
    let debounceTimer = null;

    function getData() {
      return {
        title: document.getElementById('title').value.trim(),
        notes: document.getElementById('notes').value.trim(),
      };
    }

    function scheduleAutosave() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const data = getData();
        const titleEl = document.getElementById('title');
        if (!data.title && titleEl instanceof HTMLInputElement && !titleEl.readOnly) return;
        vscode.postMessage({ type: 'autosave', data });
      }, 500);
    }

    fields.forEach(f => {
      const el = document.getElementById(f);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (!el.readOnly) {
          el.addEventListener('input', scheduleAutosave);
        }
      }
    });

    const titleLink = document.getElementById('title-link');
    if (titleLink) {
      titleLink.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openUrl', url: titleLink.dataset.url });
      });
    }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function formatTimestamp(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function stateLabel(state: WorkItemState): string {
  if (state === WorkItemState.InProgress) { return 'In Progress'; }
  return state;
}

function stateBadgeClass(state: WorkItemState): string {
  switch (state) {
    case WorkItemState.New: return 'badge-new';
    case WorkItemState.InProgress: return 'badge-inprogress';
    case WorkItemState.Paused: return 'badge-paused';
    case WorkItemState.Done: return 'badge-done';
    case WorkItemState.Archived: return 'badge-archived';
    default: return 'badge-new';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
