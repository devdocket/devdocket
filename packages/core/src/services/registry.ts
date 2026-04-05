import * as vscode from 'vscode';
import { logger } from './logger';

export class Registry<T extends { readonly id: string; readonly label: string }> {
  private readonly items = new Map<string, T>();
  private readonly kind: string;

  constructor(kind: string) { this.kind = kind; }

  register(item: T): vscode.Disposable {
    if (this.items.has(item.id)) {
      throw new Error(`${this.kind} already registered: ${item.id}`);
    }
    this.items.set(item.id, item);
    logger.info(`Registered ${this.kind.toLowerCase()}: ${item.id} (${item.label})`);
    return new vscode.Disposable(() => { this.items.delete(item.id); });
  }

  get(id: string): T | undefined { return this.items.get(id); }
  has(id: string): boolean { return this.items.has(id); }
  getAll(): T[] { return Array.from(this.items.values()); }
  get size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
