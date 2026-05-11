import * as crypto from 'crypto';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { EditorItemData } from './mainTypes';

export interface EditorHtmlOptions {
  cspSource: string;
  scriptUri: string;
  initialItem: EditorItemData;
}

export function getEditorPanelHtml({ cspSource, scriptUri, initialItem }: EditorHtmlOptions): string {
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: http: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>DevDocket Editor</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: var(--vscode-editor-background);
    }

    * {
      box-sizing: border-box;
    }

    html,
    body,
    #root {
      margin: 0;
      min-height: 100vh;
    }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    .editor-app {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .editor-empty-state {
      padding: 32px 24px;
      color: var(--vscode-descriptionForeground);
    }

    .editor-header,
    .editor-section {
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
      border-radius: 10px;
      background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08)));
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
    }

    .editor-header {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .editor-title-row,
    .editor-title-actions,
    .badge-row,
    .meta-row,
    .action-bar,
    .related-item-header,
    .activity-entry,
    .activity-entry-main {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .editor-title-row {
      justify-content: space-between;
      align-items: flex-start;
    }

    .editor-eyebrow,
    .editor-section-heading {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 11px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
    }

    button.editor-section-heading--toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
      font-family: inherit;
    }

    button.editor-section-heading--toggle:hover {
      color: var(--vscode-foreground);
    }

    .editor-section-toggle {
      display: inline-block;
      width: 0.8em;
      text-align: center;
    }

    .editor-section-count {
      font-weight: 400;
      opacity: 0.75;
    }

    .editor-title {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
      color: var(--vscode-foreground);
      word-break: break-word;
      display: inline;
    }
    /*
     * When the heading wraps an anchor (item has a URL) the anchor
     * inherits the heading's font but takes its own link colors so it
     * still reads as a clickable title.
     */
    .editor-title-link {
      color: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .editor-title-link:hover {
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
      text-decoration: underline;
    }
    .editor-title-block {
      flex: 1;
      min-width: 0;
    }
    .editor-repo-annotation {
      font-weight: 400;
      font-size: 0.95em;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      word-break: break-all;
      margin-top: 4px;
    }
    .icon-button--inline {
      width: 22px;
      height: 22px;
      font-size: 13px;
      vertical-align: middle;
      margin-left: 4px;
    }

    .badge-pill,
    .editor-status,
    .meta-pill,
    .meta-badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      line-height: 1.2;
    }

    .badge-pill {
      font-weight: 600;
    }

    .editor-status {
      font-weight: 700;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .editor-status--in-progress {
      background: rgba(56, 138, 52, 0.16);
      color: var(--vscode-terminal-ansiGreen, #388a34);
    }

    .editor-status--paused {
      background: rgba(204, 167, 0, 0.18);
      color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .editor-status--done {
      background: rgba(115, 201, 145, 0.18);
      color: var(--vscode-testing-iconPassed, #73c991);
    }

    .editor-status--archived,
    .editor-status--new {
      background: rgba(128, 128, 128, 0.16);
      color: var(--vscode-descriptionForeground);
    }

    .icon-button,
    .editor-button {
      border: 1px solid transparent;
      border-radius: 6px;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }

    .icon-button {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: var(--vscode-textLink-foreground);
    }

    .icon-button:hover,
    .editor-button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.12));
    }

    .icon-button:focus-visible,
    .editor-button:focus-visible,
    .editor-input:focus-visible,
    .related-item:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .badge-pill,
    .meta-badge {
      font-size: 12px;
    }

    .meta-pill,
    .meta-badge {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
      font-weight: 400;
    }

    .editor-section {
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .editor-title-actions {
      flex-wrap: wrap;
      align-items: center;
    }

    .editor-pills-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .editor-pills-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }

    .editor-header-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .action-bar {
      gap: 8px;
      flex-wrap: wrap;
    }

    .editor-button {
      min-height: 34px;
      padding: 0 14px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .editor-button--secondary,
    .editor-button--ghost {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
    }

    .editor-button--danger {
      background: transparent;
      color: var(--vscode-errorForeground, #f14c4c);
      border-color: rgba(241, 76, 76, 0.35);
    }

    .editor-fields-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }

    .editor-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .editor-field:last-child {
      grid-column: 1 / -1;
    }

    .editor-field-label {
      font-weight: 600;
    }

    .editor-input {
      width: 100%;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 9px 10px;
      min-height: 38px;
    }

    .editor-input[readonly] {
      border-style: dashed;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.12));
      color: var(--vscode-disabledForeground, var(--vscode-foreground));
    }

    .editor-textarea {
      resize: none;
      line-height: 1.5;
      overflow: hidden;
      min-height: 120px;
    }

    .editor-field-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .editor-description {
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
    }

    .editor-description a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .editor-description a:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }

    .editor-description h1,
    .editor-description h2,
    .editor-description h3,
    .editor-description h4,
    .editor-description h5,
    .editor-description h6 {
      margin: 18px 0 8px;
      line-height: 1.25;
    }

    .editor-description h1:first-child,
    .editor-description h2:first-child,
    .editor-description h3:first-child,
    .editor-description p:first-child {
      margin-top: 0;
    }

    .editor-description p,
    .editor-description ul,
    .editor-description ol,
    .editor-description pre,
    .editor-description blockquote,
    .editor-description table {
      margin: 8px 0;
    }

    .editor-description ul,
    .editor-description ol {
      padding-left: 24px;
    }

    .editor-description code,
    .editor-description pre {
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace));
      background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15));
      border-radius: 6px;
    }

    .editor-description code {
      padding: 1px 4px;
    }

    .editor-description pre {
      padding: 10px 12px;
      overflow-x: auto;
    }

    .editor-description pre code {
      padding: 0;
      background: transparent;
    }

    .editor-description blockquote {
      padding: 10px 14px;
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
      background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.08));
    }

    .editor-description img {
      max-width: 100%;
      height: auto;
    }

    .editor-description table {
      width: 100%;
      border-collapse: collapse;
    }

    .editor-description th,
    .editor-description td {
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      padding: 6px 8px;
      text-align: left;
    }

    .related-items,
    .related-item-group,
    .activity-log {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .ci-watch-heading-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .ci-watch-open-button {
      min-height: 28px;
      padding: 0 10px;
      font-size: 12px;
    }

    .ci-watch-run-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .ci-watch-chip,
    .ci-watch-more {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
    }

    .ci-watch-chip--pass {
      color: var(--vscode-testing-iconPassed, #73c991);
      border-color: rgba(115, 201, 145, 0.35);
      background: rgba(115, 201, 145, 0.12);
    }

    .ci-watch-chip--fail {
      color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, #f14c4c));
      border-color: rgba(241, 76, 76, 0.35);
      background: rgba(241, 76, 76, 0.12);
    }

    .ci-watch-chip--running {
      color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
      border-color: rgba(0, 122, 204, 0.35);
      background: rgba(0, 122, 204, 0.12);
    }

    .ci-watch-chip--neutral,
    .ci-watch-more {
      color: var(--vscode-descriptionForeground);
      border-color: var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
    }

    .ci-watch-empty-runs,
    .ci-watch-aggregate {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .related-item-group-heading {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 700;
    }

    .related-item {
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.04));
      width: 100%;
      padding: 10px 12px;
      text-align: left;
      color: inherit;
    }

    .related-item:hover {
      background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
    }

    .related-item-title {
      font-weight: 600;
      line-height: 1.35;
    }

    .badge-row--compact {
      gap: 6px;
      margin-top: 8px;
    }

    .activity-entry {
      justify-content: space-between;
      align-items: flex-start;
      padding: 6px 0;
      gap: 12px;
    }

    .activity-entry + .activity-entry {
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.18)));
    }

    .activity-entry-main {
      flex: 1;
      align-items: baseline;
    }

    .activity-entry-type {
      font-weight: 600;
    }

    .activity-entry-detail {
      color: var(--vscode-descriptionForeground);
    }

    .activity-entry-time {
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      white-space: nowrap;
    }

    @media (max-width: 720px) {
      .editor-app {
        padding: 16px;
      }

      .editor-title {
        font-size: 19px;
      }

      .editor-section,
      .editor-header {
        padding-left: 16px;
        padding-right: 16px;
      }

      .activity-entry {
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__DEVDOCKET_EDITOR_BOOTSTRAP__ = ${serializeForScript(initialItem)};
  </script>
  <script nonce="${nonce}" type="module" src="${escapeAttr(scriptUri)}"></script>
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

function serializeForScript(value: EditorItemData): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
