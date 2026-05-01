import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLatestChangelogEntry } from './extract-changelog.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tagPrefixes = {
  shared: 'shared-v',
  core: 'core-v',
  github: 'github-v',
  ado: 'ado-v',
  'start-git-work': 'start-git-work-v',
  'ai-reviewer': 'ai-reviewer-v'
};

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

  if (!existsSync(changelogPath)) {
    return false;
  }

  try {
    const latestEntry = extractLatestChangelogEntry(changelogPath);
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
      tagName: `${tagPrefix}${version}`
    };
  })
  .filter(Boolean);

if (releaseCandidates.length === 0) {
  console.log('No release candidates detected.');
  process.exit(0);
}

git('checkout', '-B', 'main', 'origin/main');
git('merge', '--ff-only', 'origin/dev');

const newTags = [];

for (const releaseCandidate of releaseCandidates) {
  if (tagExists(releaseCandidate.tagName)) {
    continue;
  }

  git('tag', releaseCandidate.tagName);
  newTags.push(releaseCandidate.tagName);
}

if (newTags.length === 0) {
  console.log('No new release tags to create.');
}

git('push', 'origin', 'main', ...newTags);
