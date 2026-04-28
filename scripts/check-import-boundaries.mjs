// Enforces import boundaries for provider/action packages.
// These packages may only import from: @devdocket/shared, vscode, node builtins,
// npm packages, and relative paths within the same package.

import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, dirname } from 'path';

const CONSUMER_PACKAGES = [
  'packages/github',
  'packages/ado',
  'packages/start-git-work',
  'packages/ai-reviewer',
];

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const repoRoot = resolve(import.meta.dirname, '..');

function collectTsFiles(dir, results) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === '__tests__' || entry.name === '__mocks__') {
        continue;
      }
      collectTsFiles(fullPath, results);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(fullPath);
    }
  }
}

function extractSpecifiers(content) {
  const specifiers = [];
  for (const re of [IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isNodeBuiltin(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return NODE_BUILTINS.has(bare.split('/')[0]);
}

function isRelativeEscape(specifier, filePath, pkgDir) {
  if (!specifier.startsWith('.')) {
    return false;
  }
  const resolved = resolve(dirname(filePath), specifier);
  const pkgRoot = resolve(repoRoot, pkgDir);
  return relative(pkgRoot, resolved).startsWith('..');
}

function isForbiddenBareImport(specifier) {
  // Any @devdocket/* import other than @devdocket/shared is forbidden
  if (specifier.startsWith('@devdocket/') && !specifier.startsWith('@devdocket/shared')) {
    return true;
  }
  return false;
}

function isAllowedImport(specifier) {
  if (specifier.startsWith('.')) return true;
  if (specifier === '@devdocket/shared' || specifier.startsWith('@devdocket/shared/')) return true;
  if (specifier === 'vscode') return true;
  if (isNodeBuiltin(specifier)) return true;
  if (isForbiddenBareImport(specifier)) return false;
  // Other bare specifiers are npm packages
  return true;
}

const violations = [];

for (const pkgDir of CONSUMER_PACKAGES) {
  const srcDir = resolve(repoRoot, pkgDir, 'src');
  const files = [];
  collectTsFiles(srcDir, files);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const specifiers = extractSpecifiers(content);
    const relFile = relative(repoRoot, filePath).replaceAll('\\', '/');

    for (const specifier of specifiers) {
      if (!isAllowedImport(specifier)) {
        violations.push({ file: relFile, specifier });
      } else if (isRelativeEscape(specifier, filePath, pkgDir)) {
        violations.push({ file: relFile, specifier });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Import boundary violations found:\n');
  for (const { file, specifier } of violations) {
    console.error(`  ${file}`);
    console.error(`    Forbidden import: ${specifier}\n`);
  }
  console.error(
    `${violations.length} violation(s) found. Provider/action packages may only import from ` +
    `@devdocket/shared, vscode, node builtins, and npm packages.`
  );
  process.exit(1);
} else {
  console.log('No import boundary violations found.');
}
