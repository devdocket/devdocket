import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const outputDir = resolve(packageRoot, 'webview-dist', 'codicons');
const codiconsCssPath = require.resolve('@vscode/codicons/dist/codicon.css');
const codiconsFontPath = require.resolve('@vscode/codicons/dist/codicon.ttf');

await mkdir(outputDir, { recursive: true });
await copyFile(codiconsCssPath, resolve(outputDir, 'codicon.css'));
await copyFile(codiconsFontPath, resolve(outputDir, 'codicon.ttf'));
