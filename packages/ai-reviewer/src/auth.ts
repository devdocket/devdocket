import * as vscode from 'vscode';
import { createAbortError } from '@devdocket/shared';

export const ADO_AUTH_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export interface AuthRequestOptions {
  interactive?: boolean;
  signal?: AbortSignal;
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function getGitHubSession(options: AuthRequestOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
  const { interactive = false, signal } = options;
  if (signal?.aborted) {
    throw createAbortError();
  }

  const session = await raceWithAbort(
    vscode.authentication.getSession('github', ['repo'], { silent: true }),
    signal,
  );
  if (session || !interactive) {
    return session;
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  return raceWithAbort(
    vscode.authentication.getSession('github', ['repo'], { createIfNone: true }),
    signal,
  );
}

export async function getAdoSession(options: AuthRequestOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
  const { interactive = false, signal } = options;
  if (signal?.aborted) {
    throw createAbortError();
  }

  const session = await raceWithAbort(
    vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { silent: true }),
    signal,
  );
  if (session || !interactive) {
    return session;
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  return raceWithAbort(
    vscode.authentication.getSession('microsoft', [ADO_AUTH_SCOPE], { createIfNone: true }),
    signal,
  );
}
