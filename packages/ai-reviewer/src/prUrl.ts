/** Allowed characters in GitHub org/repo names: alphanumeric, hyphens, dots, underscores. */
const SAFE_GITHUB_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const SAFE_ADO_SEGMENT = /^[^\x00-\x1f\x7f/\\]+$/;

export interface GitHubPrUrlParts {
  org: string;
  repo: string;
  prNumber: string;
}

export interface AdoPrUrlParts {
  org: string;
  project: string;
  repo: string;
  prId: string;
}

export type PrUrlParts =
  | ({ provider: 'github' } & GitHubPrUrlParts)
  | ({ provider: 'ado' } & AdoPrUrlParts);

/** Parse a GitHub PR URL, returning org, repo, and PR number. */
export function parsePrUrl(url: string): GitHubPrUrlParts | undefined {
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.hostname !== 'github.com') return undefined;

  const segments = parsed.pathname.split('/').filter(Boolean);
  // Expected: [org, repo, 'pull', number]
  if (segments.length < 4 || segments[2] !== 'pull') return undefined;

  const [org, repo, , prNumber] = segments;
  if (!SAFE_GITHUB_SEGMENT.test(org) || !SAFE_GITHUB_SEGMENT.test(repo)) return undefined;
  if (!/^\d+$/.test(prNumber)) return undefined;

  return { org, repo, prNumber };
}

/** Parse an Azure DevOps PR URL, returning organization, project, repo, and PR ID. */
export function parseAdoPrUrl(url: string): AdoPrUrlParts | undefined {
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.hostname.toLowerCase() !== 'dev.azure.com') return undefined;

  const segments = parsed.pathname.split('/').filter(Boolean);
  // Expected: [org, project, '_git', repo, 'pullrequest', id]
  if (segments.length !== 6 || segments[2] !== '_git' || segments[4] !== 'pullrequest') {
    return undefined;
  }

  const [rawOrg, rawProject, , rawRepo, , prId] = segments;
  const org = decodeUrlSegment(rawOrg);
  const project = decodeUrlSegment(rawProject);
  const repo = decodeUrlSegment(rawRepo);

  if (!org || !project || !repo) return undefined;
  if (!SAFE_ADO_SEGMENT.test(org) || !SAFE_ADO_SEGMENT.test(project) || !SAFE_ADO_SEGMENT.test(repo)) {
    return undefined;
  }
  if (!/^\d+$/.test(prId)) return undefined;

  return { org, project, repo, prId };
}

export function parsePullRequestUrl(url: string): PrUrlParts | undefined {
  const github = parsePrUrl(url);
  if (github) return { provider: 'github', ...github };
  const ado = parseAdoPrUrl(url);
  if (ado) return { provider: 'ado', ...ado };
  return undefined;
}

function decodeUrlSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function parseHttpUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
