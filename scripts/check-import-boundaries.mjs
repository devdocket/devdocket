// Enforces import boundaries for provider/action packages.
// These packages may only import from: @devdocket/shared, vscode, node builtins,
// npm packages, and relative paths within the same package.

import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, dirname } from 'path';

// Exempt packages that are not providers/actions
const EXEMPT_PACKAGES = new Set(['core', 'shared']);

const repoRoot = resolve(import.meta.dirname, '..');

function discoverConsumerPackages() {
  const pkgsDir = resolve(repoRoot, 'packages');
  return readdirSync(pkgsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !EXEMPT_PACKAGES.has(e.name))
    .map(e => `packages/${e.name}`);
}

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
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const SKIP_DIRS = new Set(['test', '__tests__', '__mocks__', 'node_modules']);

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
      if (SKIP_DIRS.has(entry.name)) {
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

function stripSingleLineComments(content) {
  return content.replace(/\/\/.*$/gm, '');
}

function extractSpecifiers(content) {
  const results = [];
  const stripped = stripSingleLineComments(content);
  for (const re of [IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(stripped)) !== null) {
      const line = stripped.slice(0, match.index).split('\n').length;
      results.push({ specifier: match[1], line });
    }
  }
  return results;
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

function isAllowedImport(specifier) {
  if (specifier.startsWith('.')) return true;
  if (specifier === '@devdocket/shared' || specifier.startsWith('@devdocket/shared/')) return true;
  if (specifier === 'vscode') return true;
  if (isNodeBuiltin(specifier)) return true;
  // Any other @devdocket/* import is forbidden
  if (specifier.startsWith('@devdocket/')) return false;
  // Other bare specifiers are npm packages
  return true;
}

const consumerPackages = discoverConsumerPackages();
const violations = [];

for (const pkgDir of consumerPackages) {
  const srcDir = resolve(repoRoot, pkgDir, 'src');
  const files = [];
  collectTsFiles(srcDir, files);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relFile = relative(repoRoot, filePath).replaceAll('\\', '/');
    const specifiers = extractSpecifiers(content);

    for (const { specifier, line } of specifiers) {
      if (!isAllowedImport(specifier) || isRelativeEscape(specifier, filePath, pkgDir)) {
        violations.push({ file: relFile, line, specifier });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Import boundary violations found:\n');
  for (const { file, line, specifier } of violations) {
    console.error(`  ${file}:${line}`);
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
