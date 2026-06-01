import * as vscode from 'vscode';
import type { GitWorkAssociation, GitWorkResolver } from '../api/types';
import type { WorkItem } from '../models/workItem';
import { logger } from './logger';

/**
 * Holds the single {@link GitWorkResolver} registered through the public
 * {@link DevDocketApi.registerGitWorkResolver} hook.
 *
 * The Start Git Work extension owns the `'work-started'` activity log
 * detail schema and registers a resolver that decodes it into a small
 * stable {@link GitWorkAssociation} shape. The core extension consults
 * this registry when building card / editor data so it can render a
 * branch / worktree badge without parsing the schema itself.
 *
 * Only one resolver is supported at a time: there is exactly one writer
 * of the schema, so allowing multiple resolvers would just create
 * ambiguity about which one wins.
 */
export class GitWorkResolverRegistry {
  private resolver: GitWorkResolver | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /**
   * Fires after the resolver is registered or unregistered. Open editor
   * panels subscribe to this so they refresh their git-work display
   * once a late-activating provider extension installs its resolver.
   */
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  /**
   * Register the git-work resolver.
   *
   * @throws If a resolver is already registered.
   */
  register(resolver: GitWorkResolver): vscode.Disposable {
    if (this.resolver) {
      throw new Error('Git-work resolver is already registered');
    }
    this.resolver = resolver;
    logger.info('Registered git-work resolver');
    this._onDidChange.fire();
    let disposed = false;
    return new vscode.Disposable(() => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (this.resolver === resolver) {
        this.resolver = undefined;
        this._onDidChange.fire();
      }
    });
  }

  /**
   * Resolve the git-work association for {@link item}. Returns `undefined`
   * when no resolver is registered, the resolver returns `undefined`, the
   * resolver throws, or the resolver returns a value that doesn't match
   * the {@link GitWorkAssociation} contract.
   *
   * Returned values are normalised — only the contract fields are copied
   * and `undefined` is returned when both fields are empty. This protects
   * the webview from a buggy resolver that returns extra non-cloneable
   * properties or an empty object.
   */
  resolve(item: Readonly<WorkItem>): GitWorkAssociation | undefined {
    const resolver = this.resolver;
    if (!resolver) {
      return undefined;
    }
    let result: GitWorkAssociation | undefined;
    try {
      result = resolver(item);
    } catch (err) {
      logger.warn('Git-work resolver threw; ignoring result', err);
      return undefined;
    }
    return normaliseGitWorkAssociation(result);
  }

  dispose(): void {
    this.resolver = undefined;
    this._onDidChange.dispose();
  }
}

function normaliseGitWorkAssociation(value: unknown): GitWorkAssociation | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const obj = value as { branch?: unknown; worktreePath?: unknown };
  const branch = typeof obj.branch === 'string' && obj.branch.length > 0 ? obj.branch : undefined;
  const worktreePath = typeof obj.worktreePath === 'string' && obj.worktreePath.length > 0 ? obj.worktreePath : undefined;
  if (!branch && !worktreePath) {
    return undefined;
  }
  return {
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
}
