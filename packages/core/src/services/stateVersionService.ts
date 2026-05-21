import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Cross-window change propagation via a version file in globalStorageUri.
 *
 * On every user-intent mutation of the work-item and inbox/read-state stores,
 * the caller bumps the version. Other VS Code windows detect the file change
 * via a FileSystemWatcher and fire `onDidExternalStateChange` so consumers can
 * invalidate their caches and re-render.
 *
 * Each instance is identified by a unique ID so it can ignore its own writes.
 */
export class StateVersionService {
  private readonly _onDidExternalStateChange = new vscode.EventEmitter<void>();
  /** Fires when another window has mutated persisted state. */
  readonly onDidExternalStateChange = this._onDidExternalStateChange.event;

  private readonly versionFileUri: vscode.Uri;
  private readonly instanceId: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private lastExternalVersionKey: string | undefined;
  private lastBumpedVersion = 0;
  private bumpTail: Promise<void> = Promise.resolve();
  private static readonly DEBOUNCE_MS = 100;

  constructor(globalStorageUri: vscode.Uri) {
    this.versionFileUri = vscode.Uri.joinPath(globalStorageUri, 'state-version.json');
    this.instanceId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startWatching(globalStorageUri);
  }

  private startWatching(globalStorageUri: vscode.Uri): void {
    try {
      // Watch the parent directory for changes to the version file
      const pattern = new vscode.RelativePattern(globalStorageUri, 'state-version.json');
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.watcher.onDidChange(() => this.onFileChanged());
      this.watcher.onDidCreate(() => this.onFileChanged());
    } catch (err) {
      logger.warn('StateVersionService: failed to create file watcher, cross-window propagation disabled', err);
    }
  }

  private onFileChanged(): void {
    if (this.disposed) { return; }

    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.checkVersion();
    }, StateVersionService.DEBOUNCE_MS);
  }

  private async checkVersion(): Promise<void> {
    if (this.disposed) { return; }
    try {
      const content = await vscode.workspace.fs.readFile(this.versionFileUri);
      const data = JSON.parse(Buffer.from(content).toString('utf-8'));
      if (data.instanceId === this.instanceId) {
        return;
      }

      const versionKey = `${String(data.instanceId)}::${String(data.version)}`;
      if (this.lastExternalVersionKey === versionKey) {
        return;
      }

      this.lastExternalVersionKey = versionKey;
      this._onDidExternalStateChange.fire();
    } catch {
      // File doesn't exist or is invalid — ignore
    }
  }

  /**
   * Bumps the version file to signal other windows that state has changed.
   * Call this after any user-intent state mutation.
   */
  async bump(): Promise<void> {
    const next = this.bumpTail.catch(() => undefined).then(async () => {
      if (this.disposed) { return; }
      const version = Math.max(Date.now(), this.lastBumpedVersion + 1);
      this.lastBumpedVersion = version;
      try {
        const data = JSON.stringify({
          instanceId: this.instanceId,
          version,
        });
        await vscode.workspace.fs.writeFile(
          this.versionFileUri,
          Buffer.from(data, 'utf-8'),
        );
      } catch (err) {
        // Non-critical — worst case is a missed cross-window update
        logger.debug('StateVersionService: failed to bump version file', err);
      }
    });
    this.bumpTail = next;
    await next;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.watcher?.dispose();
    this._onDidExternalStateChange.dispose();
  }
}
