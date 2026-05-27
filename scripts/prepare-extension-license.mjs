#!/usr/bin/env node
import { copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repoRoot, "LICENSE");
const packageDirArg = process.argv[2];

if (!packageDirArg) {
  console.error("Usage: node scripts/prepare-extension-license.mjs <package-directory>");
  process.exit(1);
}

const packageDir = resolve(process.cwd(), packageDirArg);
const packageJson = resolve(packageDir, "package.json");

if (!existsSync(source)) {
  console.error(`Root LICENSE not found at ${source}`);
  process.exit(1);
}

if (!existsSync(packageJson) || !statSync(packageJson).isFile()) {
  console.error(`Package directory must contain package.json: ${packageDir}`);
  process.exit(1);
}

copyFileSync(source, resolve(packageDir, "LICENSE"));
console.log(`Copied root LICENSE into ${packageDir}`);
