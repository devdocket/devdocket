import * as vscode from 'vscode';

export const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

/** Get ADO API headers, attaching auth if a silent session is available. */
export async function getAdoHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Accept': 'application/json', 'User-Agent': 'DevDocket-VSCode' };
  try {
    const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { silent: true });
    if (session) { headers['Authorization'] = `Bearer ${session.accessToken}`; }
  } catch { /* no session available */ }
  return headers;
}

/** Retry a request with interactive ADO auth (prompts user to sign in). */
export async function retryAdoWithAuth(apiUrl: string, signal?: AbortSignal): Promise<Response | undefined> {
  try {
    const session = await vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { createIfNone: true });
    if (session) {
      return await fetch(apiUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'DevDocket-VSCode', 'Authorization': `Bearer ${session.accessToken}` },
        signal,
      });
    }
  } catch { /* user declined */ }
  return undefined;
}

/** Throw a descriptive error for a non-ok ADO API response. */
export function throwAdoApiError(response: Response, label: string): never {
  if (response.status === 404) { throw new Error(`${label} not found. It may be private or deleted.`); }
  if (response.status === 401 || response.status === 403) { throw new Error(`ADO authentication required for ${label}. Sign in to Azure DevOps in VS Code.`); }
  throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
}
