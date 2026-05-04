/**
 * Sanitize a URL before interpolating it into an LLM prompt.
 * Allows only http(s) URLs and strips query strings, fragments, userinfo,
 * ASCII control characters, and backticks.
 */
export function sanitizePrUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '(URL unavailable)';
    }
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.href.replace(/[\x00-\x1f\x7f`]/g, '');
  } catch {
    return '(URL unavailable)';
  }
}
