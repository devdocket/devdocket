import * as crypto from 'crypto';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { WorkItem, WorkItemState } from '../models/workItem';
import type { ActivityLogEntry } from '../models/activityLog';
import { isSafeUrl } from '../utils/url';

export interface EditorHtmlOptions {
  cspSource: string;
  item: WorkItem;
  /** Display label for the provider, shown only when item.providerId is set. */
  providerLabel?: string;
  /** Read-only description from the provider. Rendered as markdown. */
  providerDescription?: string;
  /** Upstream state from the provider (e.g. "open", "closed", "Active"). Will be HTML-escaped. */
  providerState?: string;
  /** When true, the title field is read-only (managed by a live provider). */
  titleReadonly?: boolean;
}

export function getEditorPanelHtml({ cspSource, item, providerLabel, providerDescription, providerState, titleReadonly }: EditorHtmlOptions): string {
  const nonce = getNonce();
  const descriptionSection = providerDescription
    ? `    <div class="field">
      <label id="provider-desc-label">Provider Description</label>
      <div class="provider-description" role="note" aria-labelledby="provider-desc-label">${renderMarkdown(providerDescription)}</div>
    </div>`
    : '';
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src https: http:;">
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
      margin-top: 2px;
      line-height: 1.5;
    }
    .provider-description h1,
    .provider-description h2,
    .provider-description h3,
    .provider-description h4,
    .provider-description h5,
    .provider-description h6 {
      margin-top: 12px;
      margin-bottom: 6px;
      font-weight: 600;
    }
    .provider-description h1 { font-size: 1.3em; }
    .provider-description h2 { font-size: 1.15em; }
    .provider-description h3 { font-size: 1.05em; }
    .provider-description p {
      margin: 6px 0;
    }
    .provider-description ul,
    .provider-description ol {
      padding-left: 24px;
      margin: 6px 0;
    }
    .provider-description li {
      margin: 2px 0;
    }
    .provider-description pre {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 8px 10px;
      border-radius: 3px;
      overflow-x: auto;
      margin: 6px 0;
    }
    .provider-description code {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .provider-description pre code {
      background: none;
      padding: 0;
    }
    .provider-description a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .provider-description a:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .provider-description blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
      padding: 4px 12px;
      margin: 6px 0;
      opacity: 0.85;
    }
    .provider-description img {
      max-width: 100%;
      height: auto;
    }
    .provider-description table {
      border-collapse: collapse;
      margin: 6px 0;
      width: 100%;
    }
    .provider-description th,
    .provider-description td {
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      padding: 4px 8px;
      text-align: left;
    }
    .provider-description th {
      font-weight: 600;
    }
    .provider-description hr {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      margin: 10px 0;
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
    .title-link:focus,
    .title-link:focus-visible {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .activity-log {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--input-border);
    }
    .activity-entry {
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-size: 0.85em;
      padding: 4px 0;
    }
    .activity-entry + .activity-entry {
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .activity-time {
      flex-shrink: 0;
      opacity: 0.6;
      white-space: nowrap;
    }
    .activity-type {
      flex-shrink: 0;
      font-weight: 500;
    }
    .activity-detail {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <h2 id="editor-heading">${item.url && isSafeUrl(item.url) ? `<a href="${escapeAttr(item.url)}" class="title-link" id="title-link" data-url="${escapeAttr(item.url)}" title="Open in browser">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h2>
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
${providerState && item.providerId ? `      <dt>Provider State</dt>
      <dd>${escapeHtml(providerState)}</dd>` : ''}
      <dt>Created</dt>
      <dd>${escapeHtml(formatTimestamp(item.createdAt))}</dd>
      <dt>Updated</dt>
      <dd>${escapeHtml(formatTimestamp(item.updatedAt))}</dd>
    </dl>
  </div>
${renderActivityLog(item.activityLog)}
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

    function isExternalUrl(href) {
      if (!href) return false;
      try {
        const url = new URL(href, window.location.href);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }

    const descEl = document.querySelector('.provider-description');
    if (descEl) {
      descEl.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;
        const anchor = e.target.closest('a');
        if (!anchor) return;
        // Always prevent default to avoid unintended webview navigation
        e.preventDefault();
        const href = anchor.getAttribute('href');
        if (href && isExternalUrl(href)) {
          vscode.postMessage({ type: 'openUrl', url: href });
        }
      });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg && msg.type === 'updateTitle' && typeof msg.title === 'string') {
        const heading = document.getElementById('editor-heading');
        if (heading) {
          const link = heading.querySelector('#title-link');
          if (link) {
            link.textContent = msg.title;
          } else {
            heading.textContent = msg.title;
          }
        }
        const titleInput = document.getElementById('title');
        if (titleInput instanceof HTMLInputElement && titleInput.readOnly) {
          titleInput.value = msg.title;
        }
      }
    });
  </script>
</body>
</html>`;
}

const sanitizeAllowList: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'em', 'strong', 'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'del', 's', 'sup', 'sub',
    'details', 'summary',
  ],
  allowedAttributes: {
    a: ['href'],
    img: ['src', 'alt'],
  },
  allowedSchemes: ['http', 'https'],
};

export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  return sanitizeHtml(rawHtml, sanitizeAllowList);
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function renderActivityLog(log: ActivityLogEntry[] | undefined): string {
  if (!log || log.length === 0) { return ''; }
  // Show newest entries first
  const entries = [...log].reverse();
  const rows = entries.map(e =>
    `    <div class="activity-entry">
      <span class="activity-time">${escapeHtml(formatTimestamp(e.timestamp))}</span>
      <span class="activity-type">${escapeHtml(activityTypeLabel(e.type))}</span>
${e.detail !== undefined ? `      <span class="activity-detail">${escapeHtml(e.detail)}</span>` : ''}
    </div>`
  ).join('\n');
  return `  <div class="activity-log" aria-label="Activity log">
    <div class="metadata-heading">Activity</div>
${rows}
  </div>`;
}

function activityTypeLabel(type: ActivityLogEntry['type']): string {
  switch (type) {
    case 'created': return 'Created';
    case 'state-changed': return 'State changed';
    case 'updated': return 'Updated';
    case 'action-executed': return 'Action executed';
    case 'auto-completed': return 'Auto-completed';
    default: return type;
  }
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
