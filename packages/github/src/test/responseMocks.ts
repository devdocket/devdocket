export interface ErrorResponseOptions {
  status: number;
  statusText?: string;
  bodyJson?: unknown;
  bodyText?: string;
  headers?: Record<string, string>;
}

/**
 * Build a minimal `Response`-shaped mock with case-insensitive headers and
 * an async `text()`, suitable for tests that drive `throwApiError`,
 * `looksLikeRateLimited403`, or any code that reads the body / headers of a
 * non-ok response.
 */
export function makeErrorResponse(opts: ErrorResponseOptions): Response {
  const body = opts.bodyText !== undefined
    ? opts.bodyText
    : (opts.bodyJson === undefined ? '' : JSON.stringify(opts.bodyJson));
  const headerMap = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: false,
    status: opts.status,
    statusText: opts.statusText ?? '',
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
    text: async () => body,
  } as unknown as Response;
}
