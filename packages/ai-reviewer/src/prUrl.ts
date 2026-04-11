/** Allowed characters in GitHub org/repo names: alphanumeric, hyphens, dots, underscores. */
const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/** Parse a GitHub PR URL, returning org, repo, and PR number. */
export function parsePrUrl(
  url: string,
): { org: string; repo: string; prNumber: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.hostname !== 'github.com') return undefined;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

  const segments = parsed.pathname.split('/').filter(Boolean);
  // Expected: [org, repo, 'pull', number]
  if (segments.length < 4 || segments[2] !== 'pull') return undefined;

  const [org, repo, , prNumber] = segments;
  if (!SAFE_SEGMENT.test(org) || !SAFE_SEGMENT.test(repo)) return undefined;
  if (!/^\d+$/.test(prNumber)) return undefined;

  return { org, repo, prNumber };
}
