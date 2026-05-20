/**
 * Custom Changesets changelog generator for the devdocket monorepo.
 *
 * Differs from the default `@changesets/changelog-github` in two ways:
 *   1. The "Thanks @user!" attribution is omitted.
 *   2. The PR link text is `#N PR Title` instead of just `#N`, so the PR's
 *      subject is visible inline in the CHANGELOG and the auto-generated
 *      GitHub Release notes that the publish workflows derive from it.
 *
 * The output otherwise mirrors @changesets/changelog-github: a PR link,
 * an abbreviated commit link, and the changeset summary, separated by
 * dashes.
 *
 * GitHub API calls (commit -> PR lookup, PR -> title) need a token to
 * avoid the 60/hr anonymous rate limit. The publish workflow provides
 * `GITHUB_TOKEN` automatically; for local runs of `npx changeset version`
 * without a token, the formatter gracefully falls back to a PR-less line.
 */

const repoSlug = 'devdocket/devdocket';
const [owner, repoName] = repoSlug.split('/');

/**
 * GitHub PR titles can contain Markdown-significant characters that would
 * break or confuse the surrounding link syntax. Escape the subset that
 * actually matters inside a `[link text](url)` construct, plus newlines
 * which would split the line.
 */
function escapeLinkText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, ' ')
    .trim();
}

async function fetchJson(url) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${owner}-changesets-changelog`,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function lookupPullRequestForCommit(sha) {
  if (!sha) return null;
  const data = await fetchJson(
    `https://api.github.com/repos/${repoSlug}/commits/${sha}/pulls`,
  );
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  // A commit can appear in multiple PRs (e.g. backports). Prefer the merged
  // PR closest to the integration into dev — the first MERGED entry in the
  // list, or the first entry overall as a fallback.
  return data.find((pr) => pr.merged_at) ?? data[0];
}

function commitLink(sha) {
  if (!sha) return '';
  const short = sha.slice(0, 7);
  return `[\`${short}\`](https://github.com/${repoSlug}/commit/${sha})`;
}

function prLink(pr) {
  const title = escapeLinkText(pr.title);
  return `[#${pr.number} ${title}](https://github.com/${repoSlug}/pull/${pr.number})`;
}

const changelogFunctions = {
  async getReleaseLine(changeset, _type, _changelogOpts) {
    const summary = changeset.summary.trim();
    const pr = await lookupPullRequestForCommit(changeset.commit);
    const linkParts = [];
    if (pr) {
      linkParts.push(prLink(pr));
    }
    const commit = commitLink(changeset.commit);
    if (commit) {
      linkParts.push(commit);
    }

    const prefix = linkParts.length > 0 ? `${linkParts.join(' ')} - ` : '';
    return `\n\n- ${prefix}${summary}`;
  },

  async getDependencyReleaseLine(changesets, dependenciesUpdated, _changelogOpts) {
    if (dependenciesUpdated.length === 0) {
      return '';
    }

    const commitShas = changesets
      .map((c) => c.commit)
      .filter(Boolean);
    const commitMarkdown = commitShas.length > 0
      ? ` [${commitShas.map(commitLink).join(', ')}]`
      : '';

    const updatedLines = dependenciesUpdated
      .map((dep) => `  - ${dep.name}@${dep.newVersion}`)
      .join('\n');

    return `\n\n- Updated dependencies${commitMarkdown}:\n${updatedLines}`;
  },
};

export default changelogFunctions;
