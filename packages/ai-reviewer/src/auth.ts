import * as vscode from 'vscode';
import { getSessionWithAuthFallback } from '@devdocket/shared';

// Must match ADO_AUTH_SCOPE in packages/ado/src/adoAuth.ts.
// Cannot import directly due to package-boundary constraints.
export const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export interface AuthRequestOptions {
  interactive?: boolean;
  signal?: AbortSignal;
}

export async function getGitHubSession(options: AuthRequestOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
  return getSessionWithAuthFallback({
    interactive: options.interactive,
    signal: options.signal,
    getSilent: () => vscode.authentication.getSession('github', ['repo'], { silent: true }),
    getInteractive: () => vscode.authentication.getSession('github', ['repo'], { createIfNone: true }),
  });
}

export async function getAdoSession(options: AuthRequestOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
  return getSessionWithAuthFallback({
    interactive: options.interactive,
    signal: options.signal,
    getSilent: () => vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { silent: true }),
    getInteractive: () => vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { createIfNone: true }),
  });
}
