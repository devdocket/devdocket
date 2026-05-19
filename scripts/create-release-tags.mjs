import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLatestChangelogEntry } from './extract-changelog.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
// NOTE: This intentionally creates release tags for every package managed by Changesets even
// though only publish-shared.yml exists today. Non-shared tags still act as release markers;
// add publish-<package>.yml workflows separately when those packages are ready to publish.
const tagPrefixes = {
  shared: 'shared-v',
  core: 'core-v',
  github: 'github-v',
  ado: 'ado-v',
  'start-git-work': 'start-git-work-v',
  'ai-reviewer': 'ai-reviewer-v'
};

function getPublishWorkflowName(packageDirectory) {
  return `publish-${packageDirectory}.yml`;
}

function hasPublishWorkflow(packageDirectory) {
  return existsSync(resolve(repoRoot, '.github', 'workflows', getPublishWorkflowName(packageDirectory)));
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function tagExists(tagName) {
  try {
    git('rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`);
    return true;
  } catch {
    return false;
  }
}

function packageShouldBeTagged(packageDirectory, version) {
  const changelogPath = resolve(repoRoot, 'packages', packageDirectory, 'CHANGELOG.md');
  const packageHasPublishWorkflow = hasPublishWorkflow(packageDirectory);

  if (!existsSync(changelogPath)) {
    // CHANGELOG.md is created by `changeset version` on the first release. Its
    // absence means the package has never been versioned through Changesets yet
    // (bootstrap state, or a newly added package). Skip without failing; a future
    // run that includes a real changeset for this package will create the
    // changelog, and the package can be tagged then.
    if (packageHasPublishWorkflow) {
      console.warn(`Skipping ${packageDirectory}: no CHANGELOG.md yet (package has not been versioned through Changesets).`);
    }

    return false;
  }

  try {
    const latestEntry = extractLatestChangelogEntry(changelogPath);

    if (typeof latestEntry.version !== 'string' || latestEntry.version.length === 0) {
      console.warn(`Skipping ${packageDirectory}: latest CHANGELOG.md entry is missing a readable version.`);
      return false;
    }

    return latestEntry.version === version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${packageDirectory}: ${message}`);
    return false;
  }
}

function readPackageVersion(packageDirectory) {
  const packageJsonPath = resolve(repoRoot, 'packages', packageDirectory, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

git('fetch', 'origin', 'dev', 'main', '--tags');

const releaseCandidates = Object.entries(tagPrefixes)
  .map(([packageDirectory, tagPrefix]) => {
    const version = readPackageVersion(packageDirectory);

    if (!packageShouldBeTagged(packageDirectory, version)) {
      return null;
    }

    return {
      packageDirectory,
      tagName: `${tagPrefix}${version}`,
      hasPublishWorkflow: hasPublishWorkflow(packageDirectory)
    };
  })
  .filter(Boolean);

if (releaseCandidates.length === 0) {
  console.log('No release candidates detected.');
  process.exit(0);
}

git('checkout', '-B', 'main', 'origin/main');

// This runs in a single CI job against the refs fetched above. The ff-only merge uses the
// fetched origin/dev snapshot for this run; if dev advances afterwards, that newer commit is
// not included here and will be handled by a subsequent workflow run after a fresh fetch.
try {
  git('merge', '--ff-only', 'origin/dev');
} catch {
  throw new Error('Cannot fast-forward main to dev. Ensure main has not diverged from dev.');
}

const mainCommitSha = git('rev-parse', 'HEAD');

try {
  git('push', 'origin', 'main');
} catch (error) {
  console.error('Failed to push main. Ensure the GitHub App has bypass permissions for main branch protection.');
  throw error;
}

const repository = process.env.GITHUB_REPOSITORY;
if (!repository) {
  throw new Error('GITHUB_REPOSITORY env var is required (expected to be set by GitHub Actions).');
}

// Tags MUST be created via the REST API rather than `git push`. A tag pushed via `git push`
// (regardless of token type) does NOT trigger downstream tag-triggered workflows from within
// an Actions run. Creating the ref via POST /repos/{owner}/{repo}/git/refs is a documented
// path that does trigger them. See https://github.com/changesets/action/pull/391 for the
// precedent and https://github.com/h3rmanj/changesets-triggers for the empirical matrix.
function createTagViaApi(tagName, commitSha) {
  execFileSync('gh', [
    'api',
    `repos/${repository}/git/refs`,
    '--method', 'POST',
    '-f', `ref=refs/tags/${tagName}`,
    '-f', `sha=${commitSha}`,
  ], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
}

let createdTagCount = 0;

for (const releaseCandidate of releaseCandidates) {
  if (tagExists(releaseCandidate.tagName)) {
    console.log(`Skipping existing tag ${releaseCandidate.tagName}`);
    continue;
  }

  try {
    createTagViaApi(releaseCandidate.tagName, mainCommitSha);
  } catch (error) {
    console.error(`Failed to create tag ${releaseCandidate.tagName} via REST API.`);
    throw error;
  }

  createdTagCount++;

  if (releaseCandidate.hasPublishWorkflow) {
    console.log(`Created tag ${releaseCandidate.tagName} via REST API; ${getPublishWorkflowName(releaseCandidate.packageDirectory)} is present and can publish it.`);
  } else {
    console.log(`Created tag ${releaseCandidate.tagName} via REST API; no ${getPublishWorkflowName(releaseCandidate.packageDirectory)} workflow exists yet, so publishing must be added separately.`);
  }
}

if (createdTagCount === 0) {
  console.log('No new release tags created.');
  process.exit(0);
}

console.log(`Pushed main and created ${createdTagCount} tag(s) via REST API.`);
