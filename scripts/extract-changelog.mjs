import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseHeadingPattern = /^##\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/gm;

export function extractLatestChangelogEntry(changelogPath) {
  releaseHeadingPattern.lastIndex = 0;

  const contents = readFileSync(changelogPath, 'utf8');
  const firstMatch = releaseHeadingPattern.exec(contents);

  if (!firstMatch) {
    throw new Error(`No release heading found in ${changelogPath}`);
  }

  const version = firstMatch[1];
  const contentStart = firstMatch.index + firstMatch[0].length;
  const nextMatch = releaseHeadingPattern.exec(contents);
  const contentEnd = nextMatch ? nextMatch.index : contents.length;
  const content = contents.slice(contentStart, contentEnd).trim();

  return { version, content };
}

function isDirectExecution() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const changelogPath = process.argv[2];

  if (!changelogPath) {
    console.error('Usage: node scripts/extract-changelog.mjs <path-to-CHANGELOG.md>');
    process.exit(1);
  }

  try {
    const { content } = extractLatestChangelogEntry(changelogPath);
    process.stdout.write(content ? `${content}\n` : '');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
