/** Validate that a URL uses a safe scheme (http or https). */
export function isSafeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null;
  } catch {
    return null;
  }
}
