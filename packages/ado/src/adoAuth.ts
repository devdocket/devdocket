import * as vscode from 'vscode';
import { combineSignals, getSessionWithAuthFallback } from '@devdocket/shared';

export const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export interface AdoAuthOptions {
  interactive?: boolean;
  signal?: AbortSignal;
}

/** Get ADO API headers, attaching auth if a silent session is available. */
export async function getAdoHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Accept': 'application/json', 'User-Agent': 'DevDocket-VSCode' };
  try {
    const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { silent: true });
    if (session) { headers['Authorization'] = `Bearer ${session.accessToken}`; }
  } catch { /* no session available */ }
  return headers;
}

export async function getAdoSession(options: AdoAuthOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
  return getSessionWithAuthFallback({
    interactive: options.interactive,
    signal: options.signal,
    getSilent: () => vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { silent: true }),
    getInteractive: () => vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { createIfNone: true }),
  });
}

/** Retry a request with ADO auth, prompting only for interactive callers. */
export async function retryAdoWithAuth(
  apiUrl: string,
  signal?: AbortSignal,
  options: Omit<AdoAuthOptions, 'signal'> = {},
): Promise<Response | undefined> {
  try {
    const session = await getAdoSession({ ...options, signal });
    if (session) {
      const requestSignal = signal ? combineSignals(signal, 30_000) : AbortSignal.timeout(30_000);
      return await fetch(apiUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'DevDocket-VSCode', 'Authorization': `Bearer ${session.accessToken}` },
        signal: requestSignal,
      });
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw error;
    }
  }
  return undefined;
}

/** Throw a descriptive error for a non-ok ADO API response. */
export function throwAdoApiError(response: Response, label: string): never {
  if (response.status === 404) { throw new Error(`${label} not found. It may be private or deleted.`); }
  if (response.status === 401 || response.status === 403) { throw new Error(`ADO authentication required for ${label}. Sign in to Azure DevOps in VS Code.`); }
  throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
}
