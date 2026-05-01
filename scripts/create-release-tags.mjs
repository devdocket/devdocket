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
    if (packageHasPublishWorkflow) {
      throw new Error(`Cannot determine release status for ${packageDirectory}: missing CHANGELOG.md at ${changelogPath}`);
    }

    return false;
  }

  try {
    const latestEntry = extractLatestChangelogEntry(changelogPath);

    if (typeof latestEntry.version !== 'string' || latestEntry.version.length === 0) {
      if (packageHasPublishWorkflow) {
        throw new Error('latest changelog entry is missing a readable version');
      }

      return false;
    }

    return latestEntry.version === version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (packageHasPublishWorkflow) {
      throw new Error(`Cannot determine release status for ${packageDirectory}: ${message}`);
    }

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

// This runs in a single CI job. If dev advances after releaseCandidates are computed,
// the ff-only merge fails safely and the newer dev push triggers a fresh workflow run.
try {
  git('merge', '--ff-only', 'origin/dev');
} catch {
  throw new Error('Cannot fast-forward main to dev. Ensure main has not diverged from dev.');
}

const newTags = [];

for (const releaseCandidate of releaseCandidates) {
  if (tagExists(releaseCandidate.tagName)) {
    console.log(`Skipping existing tag ${releaseCandidate.tagName}`);
    continue;
  }

  git('tag', releaseCandidate.tagName);
  newTags.push(releaseCandidate.tagName);

  if (releaseCandidate.hasPublishWorkflow) {
    console.log(`Created tag ${releaseCandidate.tagName}; ${getPublishWorkflowName(releaseCandidate.packageDirectory)} is present and can publish it.`);
  } else {
    console.log(`Created tag ${releaseCandidate.tagName}; no ${getPublishWorkflowName(releaseCandidate.packageDirectory)} workflow exists yet, so publishing must be added separately.`);
  }
}

if (newTags.length === 0) {
  console.log('No new release tags to create. Skipping push.');
  process.exit(0);
}

try {
  git('push', 'origin', 'main', ...newTags);
  console.log(`Pushed main and ${newTags.length} tag(s)`);
} catch (error) {
  console.error('Failed to push to main. Ensure the GitHub App has bypass permissions for main branch protection.');
  throw error;
}
