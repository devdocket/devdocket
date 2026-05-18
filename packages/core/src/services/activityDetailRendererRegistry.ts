import * as vscode from 'vscode';
import type { ActivityType, ActivityDetailRender, ActivityDetailRenderer } from '../api/types';
import { logger } from './logger';

/**
 * Registry for {@link ActivityDetailRenderer} functions keyed by
 * {@link ActivityType}.
 *
 * Extensions register a renderer for activity types whose `detail`
 * payload they own (typically a structured JSON blob). When the
 * editor webview is built, the core extension calls
 * {@link render} on each activity entry; if a renderer is registered
 * for that type, its output is sent to the webview alongside the raw
 * detail string. The webview prefers the rendered representation
 * when present and falls back to plain text otherwise.
 *
 * This keeps the core extension free of any knowledge of the
 * `detail` schema owned by other extensions.
 */
export class ActivityDetailRendererRegistry {
  private readonly renderers = new Map<ActivityType, ActivityDetailRenderer>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /**
   * Fires after a renderer is registered or unregistered. Open editor
   * panels subscribe to this so they can re-render their activity log
   * once a relevant renderer becomes available — this matters when an
   * editor opens before the provider extension that owns the renderer
   * has finished activating.
   */
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  /**
   * Register a renderer for an activity type.
   *
   * @throws If a renderer is already registered for {@link type}.
   */
  register(type: ActivityType, renderer: ActivityDetailRenderer): vscode.Disposable {
    if (this.renderers.has(type)) {
      throw new Error(`Activity detail renderer already registered for type: ${type}`);
    }
    this.renderers.set(type, renderer);
    logger.info(`Registered activity detail renderer for type: ${type}`);
    this._onDidChange.fire();
    let disposed = false;
    return new vscode.Disposable(() => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (this.renderers.get(type) === renderer) {
        this.renderers.delete(type);
        this._onDidChange.fire();
      }
    });
  }

  /**
   * Invoke the renderer for {@link type} on {@link detail}.
   *
   * Returns `undefined` when no renderer is registered, the renderer
   * returns `undefined` or a shape that doesn't match
   * {@link ActivityDetailRender}, or the renderer throws. Renderer
   * exceptions are caught and logged so a buggy renderer cannot break
   * the editor.
   *
   * Output is also shape-validated: the rendered value is sent to the
   * editor webview via `postMessage` (which uses structured clone),
   * so a renderer that returns a non-serialisable value would
   * otherwise crash the editor update. Validation rejects unknown
   * `kind` values, non-string fields, and missing `rows`, all of
   * which would either fail structured-clone or render garbage.
   */
  render(type: ActivityType, detail: string | undefined): ActivityDetailRender | undefined {
    const renderer = this.renderers.get(type);
    if (!renderer) {
      return undefined;
    }
    let result: ActivityDetailRender | undefined;
    try {
      result = renderer(detail);
    } catch (err) {
      logger.warn(`Activity detail renderer for type "${type}" threw; falling back to plain text`, err);
      return undefined;
    }
    if (result === undefined) {
      return undefined;
    }
    if (!isValidActivityDetailRender(result)) {
      logger.warn(`Activity detail renderer for type "${type}" returned an invalid shape; falling back to plain text`);
      return undefined;
    }
    return result;
  }

  dispose(): void {
    this.renderers.clear();
    this._onDidChange.dispose();
  }
}

function isValidActivityDetailRender(value: unknown): value is ActivityDetailRender {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as { kind?: unknown };
  if (obj.kind === 'text') {
    return typeof (value as { text?: unknown }).text === 'string';
  }
  if (obj.kind === 'fields') {
    const rows = (value as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) {
      return false;
    }
    return rows.every(row => {
      if (!row || typeof row !== 'object') {
        return false;
      }
      const r = row as { label?: unknown; value?: unknown };
      return typeof r.label === 'string' && typeof r.value === 'string';
    });
  }
  return false;
}
