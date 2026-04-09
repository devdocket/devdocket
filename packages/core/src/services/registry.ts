import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Generic registry for named, identifiable items (providers, actions, etc.).
 *
 * ## Trust model
 *
 * The VS Code extension API does not expose caller identity when an extension
 * invokes another extension's API. This means we cannot verify *which* extension
 * is registering a given item — any extension that obtains the WorkCenter API
 * can register a provider or action with any `id`.
 *
 * Mitigation: the registry rejects duplicate IDs and logs every registration at
 * `warn` level so administrators can audit which items are registered and detect
 * unexpected registrations via the output channel.
 */
export class Registry<T extends { readonly id: string; readonly label: string }> {
  private readonly items = new Map<string, T>();
  private readonly kind: string;

  constructor(kind: string) { this.kind = kind; }

  register(item: T): vscode.Disposable {
    if (this.items.has(item.id)) {
      throw new Error(`${this.kind} already registered: ${item.id}`);
    }
    this.items.set(item.id, item);
    // Warn-level so admins can audit registrations — VS Code has no caller identity context
    logger.warn(`Registered ${this.kind.toLowerCase()}: ${item.id} (${item.label})`);
    let disposed = false;
    return new vscode.Disposable(() => {
      if (!disposed && this.items.get(item.id) === item) {
        this.items.delete(item.id);
      }
      disposed = true;
    });
  }

  get(id: string): T | undefined { return this.items.get(id); }
  has(id: string): boolean { return this.items.has(id); }
  getAll(): T[] { return Array.from(this.items.values()); }
  get size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
