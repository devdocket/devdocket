import * as vscode from 'vscode';
import { WorkItem } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';

export class WorkItemEditorPanel {
  private static readonly viewType = 'workcenter.editItem';
  private readonly panel: vscode.WebviewPanel;
  private readonly workGraph: WorkGraph;
  private readonly itemId: string;
  private disposed = false;

  static open(
    context: vscode.ExtensionContext,
    workGraph: WorkGraph,
    item: WorkItem,
  ): void {
    const panel = vscode.window.createWebviewPanel(
      WorkItemEditorPanel.viewType,
      `Edit: ${item.title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const editor = new WorkItemEditorPanel(panel, workGraph, item.id);
    context.subscriptions.push({ dispose: () => editor.dispose() });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    workGraph: WorkGraph,
    itemId: string,
  ) {
    this.panel = panel;
    this.workGraph = workGraph;
    this.itemId = itemId;

    this.update();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'autosave') {
          await this.saveData(msg.data);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to save work item: ${message}`);
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
    });
  }

  private async saveData(data: Record<string, string>): Promise<void> {
    if (!data.title) {
      return;
    }
    await this.workGraph.updateItem(this.itemId, {
      title: data.title,
      description: data.description || undefined,
    });
    if (!this.disposed) {
      this.panel.title = `Edit: ${data.title}`;
    }
  }

  private update(): void {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      this.panel.webview.html = '<html><body><p>Item not found.</p></body></html>';
      return;
    }
    this.panel.webview.html = this.getHtml(item);
  }

  private getHtml(item: WorkItem): string {
    const nonce = this.getNonce();
    const cspSource = this.panel.webview.cspSource;
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
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
    .actions {
      margin-top: 20px;
      display: flex;
      gap: 8px;
    }
    button {
      padding: 6px 16px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-family: var(--font);
      font-size: var(--font-size);
    }
    button.primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }
    button.primary:hover {
      background: var(--btn-hover);
    }
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--input-border);
    }
  </style>
</head>
<body>
  <h2>Edit Work Item</h2>
  <div id="form">
    <div class="field">
      <label for="title">Title</label>
      <input type="text" id="title" value="${escapeAttr(item.title)}" />
    </div>
    <div class="field">
      <label for="description">Description</label>
      <textarea id="description">${escapeHtml(item.description ?? '')}</textarea>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fields = ['title', 'description'];
    let debounceTimer = null;

    function getData() {
      return {
        title: document.getElementById('title').value.trim(),
        description: document.getElementById('description').value.trim(),
      };
    }

    function scheduleAutosave() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const data = getData();
        if (!data.title) return;
        vscode.postMessage({ type: 'autosave', data });
      }, 500);
    }

    fields.forEach(f => {
      document.getElementById(f).addEventListener('input', scheduleAutosave);
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
