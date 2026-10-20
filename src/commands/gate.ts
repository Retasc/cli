import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  statSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { resolveMcpConn, readMcpJson, workspacePrefix, type McpConn } from "../lib/claim.js";
import { claudeLocalRetascEntry } from "../lib/binding.js";
import { getBinding } from "../lib/keystore.js";

// The commit↔issue traceability gate, wired into a customer repo. Two layers,
// both parameterized by the project's prefix (never hardcoded to RTSC):
//   • commit-msg hook — local, opt-in, fast feedback. Bypassable (--no-verify),
//     and git deliberately won't run it on a fresh clone, so it can't be the
//     authoritative gate; it's the developer's early warning.
//   • check-commit-message Action — runs in CI on every PR, zero per-developer
//     setup, can't be bypassed. This is the authoritative gate.

export type GateLayers = { hook: boolean; action: boolean };

/** The keystore's stored prefix for the workspace marker at `dir`, if any —
 *  the offline fallback when the server can't be asked. Entry selection matches
 *  resolveConn: env workspace id first, then claude-local, then the folder
 *  marker. The cache answers ONLY for the key the live path would have asked
 *  (`b.key === conn.key`) — an env-selected key from a different org must not
 *  inherit this folder's cached prefix. */
function storedPrefix(dir: string, conn: McpConn, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const entry = claudeLocalRetascEntry(dir) ?? (readMcpJson(dir) as any)?.mcpServers?.retasc;
  const wsId = env.RETASC_WORKSPACE || entry?.env?.RETASC_WORKSPACE;
  const b = wsId ? getBinding(String(wsId)) : undefined;
  if (!b || b.key !== conn.key) return undefined;
  return typeof b.prefix === "string" && b.prefix ? b.prefix : undefined;
}

/** Server/keystore-derived text is validated BEFORE it's printed or trusted
 *  (same rule as whoami's control-char strip) — a malformed value is treated
 *  as unresolved, never echoed to the terminal. */
function validPrefix(p: string | undefined): string | undefined {
  if (typeof p !== "string") return undefined;
  const up = p.toUpperCase();
  return PREFIX_RE.test(up) ? up : undefined;
}

/** whoami must never hang gate install — same 10s bound as resolveBinding
 *  (binding.ts), which bare global fetch does not carry. */
const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });

export type ResolvedGatePrefix = {
  prefix: string;
  /** Where the prefix came from — printed so the choice is contestable. */
  source: "--prefix" | "workspace binding" | "workspace binding (cached)" | "global config";
  /** Set when the machine-wide default disagrees with the folder's binding. */
  shadowedDefault?: string;
};

/**
 * Resolve the prefix the gate is keyed to, folder-first (RTSC-643). The global
 * `defaultProjectPrefix` is written only by `retasc init` — it's "whatever
 * project you last init-ed", which in a bound folder can be a DIFFERENT
 * workspace's prefix. So the folder's own binding is authoritative (whoami over
 * the workspace's key, or the keystore's cached prefix offline), and the global
 * default is consulted only when the folder is unbound. A bound folder whose
 * prefix can't be resolved fails loudly rather than guessing: a gate keyed to
 * the wrong project rejects every valid commit and ships to CI.
 */
export async function resolveGatePrefix(opts: {
  flag?: string;
  dir?: string;
  defaultPrefix?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedGatePrefix> {
  // `!== undefined` so `--prefix ""` (an unset shell var) still reaches
  // installGate's validator and fails loudly instead of silently resolving.
  if (opts.flag !== undefined) return { prefix: opts.flag.toUpperCase(), source: "--prefix" };

  const cfgDefault = opts.defaultPrefix?.toUpperCase();
  // The gate is written at the git toplevel, so when the cwd (a subdirectory)
  // carries no binding, look at the toplevel too — otherwise a subdir run would
  // silently fall back to the global default behind a false "isn't bound".
  const dirs = opts.dir
    ? [opts.dir]
    : Array.from(new Set([process.cwd(), repoRoot()].filter((d): d is string => !!d)));
  let conn: McpConn | undefined;
  let boundDir = dirs[0];
  for (const d of dirs) {
    const c = resolveMcpConn({ env: opts.env, mcpJson: readMcpJson(d), dir: d });
    if (c.key) {
      conn = c;
      boundDir = d;
      break;
    }
  }
  if (conn) {
    const live = validPrefix(await workspacePrefix(conn, opts.fetchImpl ?? fetchWithTimeout));
    const prefix = live ?? validPrefix(storedPrefix(boundDir, conn, opts.env));
    if (prefix) {
      const source = live ? "workspace binding" : "workspace binding (cached)";
      const shadowed = cfgDefault && cfgDefault !== prefix ? cfgDefault : undefined;
      return shadowed ? { prefix, source, shadowedDefault: shadowed } : { prefix, source };
    }
    throw new Error(
      "this folder is bound, but its project prefix couldn't be resolved (server didn't answer, no cached prefix) — pass --prefix <PREFIX>.",
    );
  }
  if (cfgDefault) return { prefix: cfgDefault, source: "global config" };
  throw new Error(
    "no project prefix — pass --prefix <PREFIX>, or bind this folder (`retasc bind`) / run `retasc init` so it's resolved from your project.",
  );
}

// Mirror the server's project-prefix rule (convex/manage.ts PREFIX_RE): 2–10
// chars, A–Z/0–9, letter-first. The prefix is interpolated into a generated
// bash hook and a YAML grep, so validating here keeps a stray value from
// writing a broken (or hostile) gate into the customer's repo.
const PREFIX_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** commit-msg hook body requiring `<PREFIX>-NN` or `[no-issue]`. */
export function hookTemplate(prefix: string): string {
  return `#!/bin/bash
# Require a ${prefix} issue reference (${prefix}-NN) or [no-issue] in commit messages.
# Installed by \`retasc gate install\`. Enable with: git config core.hooksPath .githooks
# Note: git does not run hooks on a fresh clone — each developer opts in once.
# The authoritative gate is the check-commit-message GitHub Action (CI).

MSG=$(cat "$1")

if echo "$MSG" | grep -qiE '(${prefix}-[0-9]+|\\[no-issue\\])'; then
  exit 0
fi

echo ""
echo "ERROR: Commit message must reference a ${prefix} issue (${prefix}-NN) or include [no-issue]."
echo ""
echo "Examples:"
echo '  feat: add wave dispatch'
echo ''
echo '  ${prefix}-12'
echo ''
echo '  docs: fix typo in README [no-issue]'
echo ""
exit 1
`;
}

/** GitHub Action enforcing the reference on PR title/body. */
export function actionTemplate(prefix: string): string {
  return `name: Check commit message
# Installed by \`retasc gate install\`. The authoritative commit↔issue gate:
# runs in CI on every PR, no per-developer setup, can't be bypassed.
on:
  pull_request:
    types: [opened, synchronize, edited]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Check for ${prefix} issue reference
        env:
          PR_TITLE: \${{ github.event.pull_request.title }}
          PR_BODY: \${{ github.event.pull_request.body }}
        run: |
          if printf '%s %s' "$PR_TITLE" "$PR_BODY" | grep -qiE '(${prefix}-[0-9]+|\\[no-issue\\])'; then
            echo "✓ ${prefix} issue reference found"
            exit 0
          fi

          echo "ERROR: PR must reference a ${prefix} issue (${prefix}-NN) in title or description, or include [no-issue]."
          exit 1
`;
}

/** Locate the git repo root, or null if cwd isn't inside a working tree. */
function repoRoot(): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const root = r.stdout.trim();
  return root || null;
}

/** Point core.hooksPath at .githooks (relative to the repo root). */
function setHooksPath(root: string): boolean {
  const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: root,
    encoding: "utf8",
  });
  return !r.error && r.status === 0;
}

function writeFile(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch {
      /* best effort (e.g. Windows) */
    }
  }
}

// RTSC-645: never discard someone's edits silently. Both files are rewritten on
// every run, so a hand-customized gate (e.g. one that also matches the branch
// number) used to vanish behind a green "✓ Updated". We stamp what we generate
// with a hash of its own body, so a later run can tell "still exactly what we
// wrote" from "someone changed this" without keeping any state outside the file.
//
// Hashing the body against its OWN stamp — rather than re-rendering the current
// template and diffing — is what keeps this stable across CLI versions: changing
// template text would otherwise make every pristine file on every machine look
// edited and warn on upgrade.

const STAMP_PREFIX = "# retasc-gate: sha256=";
const STAMP_RE = /^# retasc-gate: sha256=([0-9a-f]{64})$/;

/** Compare and hash on normalized text: a CRLF checkout (Git for Windows'
 *  autocrlf default) or a stray BOM must not make our own untouched file look
 *  edited on every single run. */
function normalizeText(s: string): string {
  return s.replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

function bodyHash(body: string): string {
  return createHash("sha256").update(normalizeText(body), "utf8").digest("hex");
}

/** Append the stamp as the final line — after the shebang and after any YAML, so
 *  placement never depends on the file's syntax. Both layers take `#` comments. */
export function withStamp(body: string): string {
  return `${body}${STAMP_PREFIX}${bodyHash(body)}\n`;
}

/** Split a stamped file back into (body, recorded hash), or null when the last
 *  line isn't one of our stamps. */
function splitStamp(raw: string): { body: string; hash: string } | null {
  const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const cut = trimmed.lastIndexOf("\n");
  const last = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  const m = last.match(STAMP_RE);
  if (!m) return null;
  return { body: cut === -1 ? "" : trimmed.slice(0, cut + 1), hash: m[1] };
}

export type GateFileState = "absent" | "pristine" | "modified";

/** Classify what's on disk. Anything we can't positively prove we generated —
 *  no stamp, a broken stamp, an unreadable file — counts as `modified`, because
 *  the cost of a needless backup is a stray file and the cost of the wrong call
 *  is someone's work. */
export function classifyGateFile(path: string): GateFileState {
  if (!existsSync(path)) return "absent";
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "modified";
  }
  // Normalize BEFORE splitting: on a CRLF checkout the stamp line ends in \r and
  // would never match, so our own untouched file would look edited on every run
  // and pile up a fresh .bak each time.
  const s = splitStamp(normalizeText(raw));
  if (!s) return "modified";
  return s.hash === bodyHash(s.body) ? "pristine" : "modified";
}

/** Pick where this backup goes. `<path>.bak` when it's free, or already holds
 *  exactly these bytes (a repeated run of the same edit shouldn't pile up
 *  copies); otherwise the first free `<path>.bak.2`, `.bak.3`, ... Overwriting a
 *  backup that holds DIFFERENT bytes would lose the only copy of an earlier
 *  edit — someone who edits, installs, edits again and installs again — which is
 *  the exact data loss this change exists to stop. */
function nextBackupPath(path: string): string {
  const first = `${path}.bak`;
  if (!existsSync(first)) return first;
  // Unreadable source (it classified as `modified` precisely because we couldn't
  // read it): we can't compare, so take a fresh slot rather than crash or clobber.
  let current: Buffer | null = null;
  try {
    current = readFileSync(path);
  } catch {
    current = null;
  }
  try {
    if (current && readFileSync(first).equals(current)) return first;
  } catch {
    /* unreadable backup: fall through and take a fresh slot rather than clobber it */
  }
  for (let n = 2; n < 100; n++) {
    const candidate = `${path}.bak.${n}`;
    if (!existsSync(candidate)) return candidate;
    try {
      if (current && readFileSync(candidate).equals(current)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    `refusing to overwrite an existing backup: ${first} through ${path}.bak.99 are all taken — clear the ones you don't need and re-run`,
  );
}

/** Copy to the slot `nextBackupPath` picked, preserving the mode so a restored
 *  hook is still executable (a `mv` of a 0644 backup would silently stop
 *  running). */
function backupFile(path: string): string {
  const bak = nextBackupPath(path);
  copyFileSync(path, bak);
  try {
    chmodSync(bak, statSync(path).mode & 0o777);
  } catch {
    /* best effort (e.g. Windows) */
  }
  return bak;
}

/**
 * Write one gate layer, backing up first when the file on disk isn't ours.
 * Returns the line to print, so both layers report identically.
 */
function writeLayer(root: string, path: string, body: string, mode?: number): string[] {
  const state = classifyGateFile(path);
  const rel = relative(root, path);
  const lines: string[] = [];
  if (state === "modified") {
    const bak = backupFile(path);
    lines.push(`⚠ ${rel} had local edits — saved to ${relative(root, bak)} before replacing it.`);
  }
  writeFile(path, withStamp(body), mode);
  lines.push(`✓ ${state === "absent" ? "Wrote" : "Updated"} ${rel}`);
  return lines;
}

/**
 * Install the commit↔issue gate into the current repo, parameterized by `prefix`.
 * Writes the requested layers (hook and/or Action) and enables the hook path.
 */
export function installGate(opts: { prefix: string; layers: GateLayers }): void {
  if (!PREFIX_RE.test(opts.prefix)) {
    throw new Error(
      `invalid prefix '${opts.prefix}' — must be 2–10 chars, A–Z/0–9, letter-first (e.g. RTSC)`,
    );
  }

  const root = repoRoot();
  if (!root) {
    throw new Error("not a git repository — run `git init` first, then re-run from the repo root");
  }

  const { hook, action } = opts.layers;
  if (!hook && !action) {
    throw new Error("nothing to install — drop --no-hook/--no-action or pick at least one layer");
  }

  let backedUp = false;

  if (hook) {
    const hookPath = join(root, ".githooks", "commit-msg");
    backedUp = classifyGateFile(hookPath) === "modified" || backedUp;
    for (const line of writeLayer(root, hookPath, hookTemplate(opts.prefix), 0o755)) {
      console.log(line);
    }
    if (setHooksPath(root)) {
      console.log("  Enabled: git config core.hooksPath .githooks");
    } else {
      console.log("  ⚠ Could not set core.hooksPath — run: git config core.hooksPath .githooks");
    }
  }

  if (action) {
    const actionPath = join(root, ".github", "workflows", "check-commit-message.yml");
    backedUp = classifyGateFile(actionPath) === "modified" || backedUp;
    for (const line of writeLayer(root, actionPath, actionTemplate(opts.prefix))) {
      console.log(line);
    }
  }

  console.log("");
  console.log(`Gate is keyed to prefix "${opts.prefix}" — commits/PRs need ${opts.prefix}-NN or [no-issue].`);
  if (action) {
    console.log("The Action is the authoritative gate (runs in CI, no per-developer setup).");
  }
  if (hook) {
    console.log(
      "The hook is local fast-feedback only: opt-in per clone (git won't auto-install it) and bypassable with --no-verify.",
    );
  }
  if (backedUp) {
    console.log(
      "\nA file you had customized was replaced by the standard one. Diff the .bak against it before committing, and re-apply anything you want to keep.",
    );
  }
  console.log("\nCommit the written files so the gate ships with the repo.");
}
