import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authentication } from 'vscode';
import { retryAdoWithAuth } from '../adoAuth';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('retryAdoWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws abort without requesting a session when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(retryAdoWithAuth('https://dev.azure.com/org/_apis/test', controller.signal, { interactive: true }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(authentication.getSession).not.toHaveBeenCalled();
  });

  it('rejects when cancellation fires while waiting for getSession', async () => {
    const controller = new AbortController();
    const pending = deferred<any>();
    vi.mocked(authentication.getSession).mockReturnValueOnce(pending.promise);

    const promise = retryAdoWithAuth('https://dev.azure.com/org/_apis/test', controller.signal, { interactive: true });
    controller.abort();
    pending.resolve(undefined);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks for a silent session before skipping background retries', async () => {
    vi.mocked(authentication.getSession).mockResolvedValueOnce(undefined as never);

    await expect(retryAdoWithAuth('https://dev.azure.com/org/_apis/test', undefined, { interactive: false }))
      .resolves.toBeUndefined();
    expect(authentication.getSession).toHaveBeenCalledTimes(1);
    expect(authentication.getSession).toHaveBeenCalledWith(
      'microsoft',
      ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      { silent: true },
    );
  });

  it('falls back to createIfNone only for interactive callers', async () => {
    vi.mocked(authentication.getSession)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce({ accessToken: 'interactive-token' } as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await retryAdoWithAuth('https://dev.azure.com/org/_apis/test', undefined, { interactive: true });

    expect(authentication.getSession).toHaveBeenNthCalledWith(
      1,
      'microsoft',
      ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      { silent: true },
    );
    expect(authentication.getSession).toHaveBeenNthCalledWith(
      2,
      'microsoft',
      ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      { createIfNone: true },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
