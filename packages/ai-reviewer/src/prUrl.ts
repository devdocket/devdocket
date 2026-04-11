/** Parse a GitHub PR URL, returning org, repo, and PR number. */
export function parsePrUrl(
  url: string,
): { org: string; repo: string; prNumber: string } | undefined {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[\/?#])/,
  );
  if (!match) return undefined;
  return { org: match[1], repo: match[2], prNumber: match[3] };
}
