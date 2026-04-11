import * as vscode from 'vscode';
import { WorkItem, WorkItemInput } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { getEditorPanelHtml } from './editorPanelHtml';

export class WorkItemEditorPanel {
  private static readonly viewType = 'workcenter.editItem';
  private static readonly openPanels = new Map<string, WorkItemEditorPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly workGraph: WorkGraph;
  private readonly itemId: string;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingData: Record<string, string> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly messageSubscription: vscode.Disposable;

  static open(
    context: vscode.ExtensionContext,
    workGraph: WorkGraph,
    item: WorkItem,
  ): void {
    const existing = WorkItemEditorPanel.openPanels.get(item.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      WorkItemEditorPanel.viewType,
      `Edit: ${item.title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const editor = new WorkItemEditorPanel(panel, workGraph, item.id);
    WorkItemEditorPanel.openPanels.set(item.id, editor);
    context.subscriptions.push({ dispose: () => editor.dispose() });
  }

  /** @internal Exposed for testing only. */
  static clearPanelCache(): void {
    WorkItemEditorPanel.openPanels.clear();
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

    this.messageSubscription = this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'autosave' && msg.data && typeof msg.data === 'object') {
        this.pendingData = msg.data;
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          const data = this.pendingData;
          this.pendingData = undefined;
          if (!data) {
            return;
          }
          this.enqueueSave(data);
        }, 300);
      }
    });

    this.panel.onDidDispose(() => {
      if (!this.disposed) {
        this.disposed = true;
        WorkItemEditorPanel.openPanels.delete(this.itemId);
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
        }
        this.flushPendingData();
        this.messageSubscription.dispose();
      }
    });
  }

  private async saveData(data: Record<string, string>): Promise<void> {
    const item = this.workGraph.getItem(this.itemId);
    if (!item) {
      throw new Error('Work item no longer exists. Your changes could not be saved.');
    }
    const patch: Partial<WorkItemInput> = {};

    if (!item.providerId) {
      if (!data.title) {
        return;
      }
      patch.title = data.title;
    }

    if ('notes' in data) {
      patch.notes = data.notes || undefined;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    await this.workGraph.updateItem(this.itemId, patch);
    if (!this.disposed && data.title && !item.providerId) {
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
    return getEditorPanelHtml({
      cspSource: this.panel.webview.cspSource,
      item,
    });
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      WorkItemEditorPanel.openPanels.delete(this.itemId);
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
      }
      this.flushPendingData();
      this.messageSubscription.dispose();
      this.panel.dispose();
    }
  }

  private flushPendingData(): void {
    const data = this.pendingData;
    this.pendingData = undefined;
    if (data) {
      this.enqueueSave(data);
    }
  }

  private enqueueSave(data: Record<string, string>): void {
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.saveData(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to save work item: ${message}`);
      }
    });
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
