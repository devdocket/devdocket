import * as vscode from 'vscode';
import { WorkItem, WorkItemInput } from '../models/workItem';
import { WorkGraph } from '../services/workGraph';
import { getEditorPanelHtml } from './editorPanelHtml';

export class WorkItemEditorPanel {
  private static readonly viewType = 'workcenter.editItem';
  private readonly panel: vscode.WebviewPanel;
  private readonly workGraph: WorkGraph;
  private readonly itemId: string;
  private disposed = false;
  private readonly messageSubscription: vscode.Disposable;

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

    this.messageSubscription = this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'autosave') {
          await this.saveData(msg.data);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to save work item: ${message}`);
      }
    });

    this.panel.onDidDispose(() => {
      if (!this.disposed) {
        this.disposed = true;
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
      this.messageSubscription.dispose();
      this.panel.dispose();
    }
  }

}
