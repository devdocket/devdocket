#!/usr/bin/env node
// Mints a short-lived (≤ 1 hour) installation access token from the DevDocket
// bot GitHub App and prints shell commands that configure the current shell
// (and the working tree's git config) to use the bot identity for subsequent
// `gh` / `git` invocations.
//
// Implements the local-developer half of devdocket/devdocket#681.
//
// Usage (bash/zsh):
//   eval "$(node scripts/start-bot-session.mjs --shell=bash)"
//
// Usage (PowerShell):
//   node scripts/start-bot-session.mjs --shell=powershell | Invoke-Expression
//
// If --shell is omitted, the script picks bash on POSIX and powershell on Windows.
//
// Required inputs (none of which are committed):
//   keys/devdocket-bot.pem        GitHub App private key (PEM, RS256).
//   keys/devdocket-bot.app-id     Numeric GitHub App ID — OR set the
//                                 DEVDOCKET_BOT_APP_ID env var instead.
//
// The `keys/` directory is git-ignored. Developers place their copy of the
// App's private key there. The script never reads or writes the key outside
// that directory.

import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_OWNER = "devdocket";
const REPO_NAME = "devdocket";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const keysDir = resolve(repoRoot, "keys");
const pemPath = resolve(keysDir, "devdocket-bot.pem");
const appIdPath = resolve(keysDir, "devdocket-bot.app-id");

function fail(msg) {
  process.stderr.write(`start-bot-session: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { shell: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--shell=")) out.shell = a.slice("--shell=".length);
    else if (a === "-h" || a === "--help") out.help = true;
    else fail(`unknown argument: ${a}`);
  }
  return out;
}

function detectShell() {
  return process.platform === "win32" ? "powershell" : "bash";
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signAppJwt(appId, privateKeyPem) {
  // GitHub recommends iat be at most 60s in the past to tolerate clock drift,
  // and exp at most 10 minutes in the future.
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: String(appId) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

async function ghApi(path, { method = "GET", token, accept, body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "devdocket-start-bot-session",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    fail(
      `GitHub API ${method} ${path} failed: ${res.status} ${res.statusText}\n${text}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

function loadAppId() {
  const fromEnv = process.env.DEVDOCKET_BOT_APP_ID;
  const raw = fromEnv && fromEnv.trim()
    ? fromEnv.trim()
    : existsSync(appIdPath)
      ? readFileSync(appIdPath, "utf8").trim()
      : "";
  if (!raw) {
    fail(
      `App ID not found. Set DEVDOCKET_BOT_APP_ID or write the numeric App ID to ${appIdPath}.`,
    );
  }
  if (!/^[0-9]+$/.test(raw)) {
    fail(
      `App ID must be a positive integer; got ${JSON.stringify(raw.slice(0, 40))}.`,
    );
  }
  return raw;
}

function loadPrivateKey() {
  if (!existsSync(pemPath)) {
    fail(
      `Private key not found at ${pemPath}. Download the DevDocket bot App's PEM and place it there.`,
    );
  }
  return readFileSync(pemPath, "utf8");
}

function emitEnv(shell, vars) {
  const out = [];
  if (shell === "powershell") {
    for (const [k, v] of Object.entries(vars)) {
      // Single-quoted PowerShell strings only need '' for embedded single quotes.
      const escaped = String(v).replace(/'/g, "''");
      out.push(`$env:${k} = '${escaped}'`);
    }
  } else if (shell === "bash") {
    for (const [k, v] of Object.entries(vars)) {
      // Single-quoted POSIX strings only need '\'' for embedded single quotes.
      const escaped = String(v).replace(/'/g, "'\\''");
      out.push(`export ${k}='${escaped}'`);
    }
  } else {
    fail(`unsupported --shell: ${shell} (expected bash or powershell)`);
  }
  return out.join("\n");
}

function emitGitConfig(shell, name, email) {
  // Configure the local repo (not --global) so the bot identity only applies
  // inside this working tree. The caller controls cwd; we use `git -C repoRoot`.
  const repoPath = repoRoot;
  const quote = (s) =>
    shell === "powershell"
      ? `'${String(s).replace(/'/g, "''")}'`
      : `'${String(s).replace(/'/g, "'\\''")}'`;
  return [
    `git -C ${quote(repoPath)} config user.name ${quote(name)}`,
    `git -C ${quote(repoPath)} config user.email ${quote(email)}`,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      `Usage:\n  eval "$(node scripts/start-bot-session.mjs --shell=bash)"\n  node scripts/start-bot-session.mjs --shell=powershell | Invoke-Expression\n`,
    );
    return;
  }
  const shell = args.shell ?? detectShell();

  // Safety: refuse to print the token to a real terminal. If stdout is a TTY
  // (i.e. the user forgot the `eval` / `Invoke-Expression` wrapper), the raw
  // `GH_TOKEN='ghs_...'` line would end up in the terminal scrollback and the
  // shell history file. Force the caller to pipe / capture the output.
  if (process.stdout.isTTY) {
    fail(
      "stdout is a TTY; refusing to print the installation token in the clear.\n" +
        '  bash/zsh:    eval "$(node scripts/start-bot-session.mjs --shell=bash)"\n' +
        "  PowerShell:  node scripts/start-bot-session.mjs --shell=powershell | Invoke-Expression",
    );
  }

  const appId = loadAppId();
  const privateKey = loadPrivateKey();

  const jwt = signAppJwt(appId, privateKey);

  // 1. Look up the App's own metadata (slug + numeric user id are needed to
  //    build the noreply commit email that GitHub maps to the bot account).
  const appMeta = await ghApi("/app", { token: jwt });
  const slug = appMeta.slug;
  if (!slug) fail("GitHub App metadata missing `slug`.");

  const botUser = await ghApi(`/users/${slug}%5Bbot%5D`, { token: jwt });
  const botUserId = botUser.id;
  if (!botUserId) fail(`Could not resolve numeric user id for ${slug}[bot].`);

  // 2. Find the installation on devdocket/devdocket.
  const installation = await ghApi(
    `/repos/${REPO_OWNER}/${REPO_NAME}/installation`,
    { token: jwt },
  );
  const installationId = installation.id;
  if (!installationId)
    fail(`App is not installed on ${REPO_OWNER}/${REPO_NAME}.`);

  // 3. Mint a short-lived installation token (≤ 1 hour), narrowed to just
  //    this repo and to the permissions agent flows actually need so a leaked
  //    token has minimal blast radius.
  const tokenResp = await ghApi(
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: jwt,
      body: {
        repositories: [REPO_NAME],
        permissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
          metadata: "read",
        },
      },
    },
  );
  const token = tokenResp.token;
  const expiresAt = tokenResp.expires_at;
  if (!token) fail("Installation token response missing `token`.");

  const botName = `${slug}[bot]`;
  const botEmail = `${botUserId}+${slug}[bot]@users.noreply.github.com`;

  // Emit shell commands. GH_TOKEN makes subsequent `gh` calls use the bot.
  // Commits made in the working tree will be authored by the bot, but note
  // that `git push` over HTTPS still uses the developer's stored credential
  // helper — so the *pusher* is the developer even though commit authorship
  // is the bot. Use `gh pr create` / `gh ...` for bot-attributed remote
  // actions; that's what consumes GH_TOKEN.
  const blocks = [
    emitEnv(shell, { GH_TOKEN: token, GITHUB_TOKEN: token }),
    emitGitConfig(shell, botName, botEmail),
  ];

  process.stdout.write(blocks.join("\n") + "\n");

  // Human-readable status on stderr so it doesn't get eval'd. Phrased as
  // "emitted" (not "applied") since nothing is configured until the caller
  // actually pipes stdout into `eval` / `Invoke-Expression`.
  process.stderr.write(
    `start-bot-session: minted installation token for ${botName} (expires ${expiresAt}).\n` +
      `start-bot-session: emitted shell commands to set git user.name / user.email in ${repoRoot}\n` +
      `start-bot-session: and to export GH_TOKEN / GITHUB_TOKEN. Run via eval / Invoke-Expression to apply.\n`,
  );
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
