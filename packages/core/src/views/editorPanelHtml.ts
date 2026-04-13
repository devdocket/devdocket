import * as crypto from 'crypto';
import { WorkItem } from '../models/workItem';

export interface EditorHtmlOptions {
  cspSource: string;
  item: WorkItem;
}

export function getEditorPanelHtml({ cspSource, item }: EditorHtmlOptions): string {
  const nonce = getNonce();
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
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --font: var(--vscode-font-family, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      font-size: var(--font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      max-width: 560px;
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
  </style>
</head>
<body>
  <h2 id="editor-heading">Edit Work Item</h2>
  <div id="form" role="form" aria-labelledby="editor-heading">
    <div class="field">
      <label for="title">Title</label>
      <input type="text" id="title" value="${escapeAttr(item.title)}" ${item.providerId ? 'readonly aria-readonly="true" aria-describedby="readonly-title-hint"' : ''} />
${item.providerId ? '      <span id="readonly-title-hint" class="hint">Title is managed by the provider</span>' : ''}
    </div>
    <div class="field">
      <label for="notes">Notes</label>
      <textarea id="notes" placeholder="Add notes...">${escapeHtml(item.notes ?? '')}</textarea>
    </div>
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
  </script>
</body>
</html>`;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
