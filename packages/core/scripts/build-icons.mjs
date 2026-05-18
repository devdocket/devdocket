import { mkdir, rm, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const globModule = require('glob');
const originalGlob = globModule.glob;
// Fantasticon builds glob patterns with path.join(), so normalize Windows separators before glob resolves SVG inputs.
globModule.glob = (pattern, options) => originalGlob(pattern.replaceAll('\\', '/'), options);
const { FontAssetType, generateFonts } = require('fantasticon');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const resourcesDir = resolve(packageRoot, 'resources');
const buildDir = resolve(resourcesDir, 'icon-font-build');
const inputDir = resolve(buildDir, 'input');
const toGlobPath = (path) => path.replaceAll('\\', '/');

try {
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(inputDir, { recursive: true });
  await copyFile(
    resolve(resourcesDir, 'devdocket-logo-mono.svg'),
    resolve(inputDir, 'devdocket-logo.svg'),
  );

  await generateFonts({
    inputDir: toGlobPath(inputDir),
    outputDir: toGlobPath(resourcesDir),
    name: 'devdocket-icons',
    fontTypes: [FontAssetType.WOFF],
    assetTypes: [],
    codepoints: {
      'devdocket-logo': 0xe001,
    },
    fontHeight: 16,
    normalize: true,
  });
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
