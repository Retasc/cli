import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gitCommonDir, realPath } from "./gitRepo.js";

// RTSC-92 (DESIGN §13): the home keystore. Workspace keys live HERE, never in a
// project tree, keyed by an opaque workspace id (not a path — no home-dir leak,
// portable across a team). The folder's ./.mcp.json marker is secret-free and
// only carries the id; the proxy + CLI resolve the id to a key through this file.
// Mode 0600 — secrets, user-only.

export type BindingEntry = {
  orgId: string;
  projectId: string;
  key: string;
  url: string;
  prefix?: string;
  orgName?: string;
  // The folder this id was bound at. Resolution is by id (portable), but a
  // mismatch is a signal that a marker reused someone else's id — `doctor` warns.
  boundPath?: string;
  createdAt: number;
  /**
   * RTSC-1014 — the per-TOOL credentials minted under `key`, by resolved harness id
   * (`claude-code`, `codex`, `grok`). The middle tier of the lineage: the proxy mints one
   * the first time a tool starts in this folder and reuses it forever after, which is
   * what lets one tool be retired without touching its siblings.
   *
   * CACHED rather than re-minted per session, and not only for thrift: only the hash is
   * stored server-side, so a mint can never hand back an existing credential and always
   * returns a new one. Without this, every session would leave another live harness key
   * behind and `api_keys` would grow a row per session per tool — and RTSC-985 is already
   * open on this deployment's read volume.
   *
   * A value here may be DEAD: the credential is revoked the moment a human retires that
   * tool, and nothing tells this file. That is handled where it is USED, not here — the
   * server refuses to mint a replacement for a retired harness, so a stale entry ends in a
   * refusal rather than a silent re-mint. Do not "heal" it by deleting the entry.
   */
  harnessKeys?: Record<string, string>;
};

type Keystore = { version: 1; bindings: Record<string, BindingEntry> };

/** The dir the keystore lives in. RETASC_DIR overrides it (tests, sandboxes). */
function keystoreDir(): string {
  return process.env.RETASC_DIR || join(homedir(), ".retasc");
}

export function keystorePath(): string {
  return join(keystoreDir(), "bindings.json");
}

export function loadKeystore(): Keystore {
  const p = keystorePath();
  if (!existsSync(p)) return { version: 1, bindings: {} };
  try {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    return { version: 1, bindings: doc?.bindings ?? {} };
  } catch {
    // Corrupt keystore — don't crash; treat as empty (a re-bind heals it).
    return { version: 1, bindings: {} };
  }
}

export function saveKeystore(ks: Keystore): void {
  // Dir user-only, file 0600 on the initial write — the keystore holds API keys,
  // so it must never exist world-readable even for the sub-ms before the chmod.
  mkdirSync(keystoreDir(), { recursive: true, mode: 0o700 });
  const p = keystorePath();
  writeFileSync(p, JSON.stringify(ks, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600); // secrets — user-only (covers overwriting an existing 0644 file)
  } catch {
    /* best effort (e.g. Windows) */
  }
}

export function getBinding(workspaceId: string): BindingEntry | undefined {
  return loadKeystore().bindings[workspaceId];
}

export function setBinding(workspaceId: string, entry: BindingEntry): void {
  const ks = loadKeystore();
  ks.bindings[workspaceId] = entry;
  saveKeystore(ks);
}

/**
 * RTSC-1014 — remember the credential this tool got in this folder.
 *
 * Read-modify-write on the whole keystore, like every other writer here: two tools
 * starting at once in one folder is ordinary (that is the case this feature exists for),
 * and each must not drop the other's entry. The window is still not zero — this file has
 * no lock — but a lost entry costs one extra mint next start, not correctness.
 *
 * A no-op when the binding is gone (unbound mid-session): there is nothing to hang the
 * credential off, and re-creating the binding here would resurrect a folder a human just
 * disconnected.
 */
export function rememberHarnessKey(workspaceId: string, harness: string, key: string): void {
  const ks = loadKeystore();
  const entry = ks.bindings[workspaceId];
  if (!entry) return;
  entry.harnessKeys = { ...entry.harnessKeys, [harness]: key };
  saveKeystore(ks);
}

export function removeBinding(workspaceId: string): void {
  const ks = loadKeystore();
  delete ks.bindings[workspaceId];
  saveKeystore(ks);
}

/** A fresh opaque workspace id for a marker. Not secret, not a path. */
export function newWorkspaceId(): string {
  return `ws_${randomUUID()}`;
}

/**
 * RTSC-780: the sentinel that means "work out the workspace from where you were
 * spawned", rather than naming one.
 *
 * A marker carrying a real `ws_…` id names ONE workspace, so an entry holding it
 * is only ever correct in the folder it was written for. That is why there is no
 * global scope today (RTSC-91): a machine-wide entry with an id in it would route
 * every folder on the disk to one org. `auto` carries no identity at all, so an
 * entry holding it IS safe to write once, machine-wide, into every harness — the
 * proxy resolves the folder it was spawned in against the keystore at startup and
 * the org still comes from the folder, exactly as before.
 *
 * Not a possible collision: ids are `ws_`-prefixed uuids.
 */
export const AUTO_WORKSPACE = "auto";

/**
 * Which binding covers this directory? (RTSC-780)
 *
 * Walks UP from `dir`, matching `boundPath` at each level, so an agent spawned in
 * a subdirectory of a bound project resolves to that project instead of to
 * nothing. The walk is what makes `auto` usable in practice: harnesses spawn a
 * stdio server in the project root, but not every one of them, and a human running
 * `retasc claim` from `src/` should not be told the folder is unbound.
 *
 * Paths are compared resolved, so `/tmp` vs `/private/tmp` and a trailing slash
 * don't produce a false miss.
 *
 * Newest wins when two ids claim the same path. A re-bind normally REUSES the
 * folder's existing id (bind.ts), but a folder bound, unbound and bound again
 * leaves an older entry behind, and the fresher one is the live binding.
 *
 * The walk STOPS at the repository root, and that bound is load-bearing rather than
 * tidiness. An unbounded walk means binding a directory binds everything beneath it:
 * run `retasc bind` once in `~/Development` (or `~`) and every project under it
 * silently starts acting in that org, with no marker in those folders saying so and
 * nothing on screen to notice. That is the cross-org leak this whole design exists to
 * avoid (RTSC-91), reintroduced through the back door. A repository is the unit a
 * person means by "project", so it is the unit the walk is allowed to cross: `src/lib`
 * resolves to its repo, and a sibling repo checked out inside a bound directory
 * resolves to nothing.
 *
 * Detected by the presence of `.git`, which is a FILE in a worktree and a directory in
 * a normal clone, so `existsSync` is the right test for both.
 */
export function findBindingByPath(
  dir: string,
): { workspaceId: string; entry: BindingEntry } | undefined {
  const bindings = loadKeystore().bindings;
  // Index by resolved boundPath once, keeping the newest per path.
  const byPath = new Map<string, { workspaceId: string; entry: BindingEntry }>();
  for (const [workspaceId, entry] of Object.entries(bindings)) {
    if (!entry?.boundPath) continue;
    const key = resolve(entry.boundPath);
    const prev = byPath.get(key);
    if (!prev || (entry.createdAt ?? 0) > (prev.entry.createdAt ?? 0)) {
      byPath.set(key, { workspaceId, entry });
    }
  }
  let cur = resolve(dir);
  // Bounded twice: by the repository root (below), and by the filesystem root, since
  // `dirname("/")` is `"/"` and ends the loop for a directory outside any repo.
  for (;;) {
    const hit = byPath.get(cur);
    if (hit) return hit;
    // Checked AFTER the lookup so the repo root itself, the folder `bind` actually
    // writes, is always eligible.
    if (existsSync(join(cur, ".git"))) break;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }

  // RTSC-862 — the walk stopped at a repository root that is not itself bound. Before
  // giving up, ask the question a person actually means: is this a WORKTREE of a repo
  // they already bound?
  //
  // The stop above is correct and stays. An unbounded walk would let `retasc bind` in
  // `~` silently bind every project beneath it, which is the cross-org leak RTSC-91
  // exists to prevent. But `.git` is a FILE at the root of every git worktree, so that
  // same stop fires on the first step inside one — and this repo's own workflow mandates
  // a worktree per claimed issue, created as a SIBLING of the checkout. Every one of them
  // resolved to nothing, with no error and no hint: the tools were simply absent. The
  // rational response is to paste a raw key into a config that works everywhere, and that
  // silently costs the watchdog, session rows, transcripts and the folder name.
  //
  // "Same repository" is decided by git's COMMON DIR, the one directory every worktree of
  // a repo shares, so a sibling repo checked out inside a bound directory still resolves
  // to nothing — different common dir. RTSC-91's property is untouched.
  //
  // A path match always wins, because this runs only after the walk found none: a
  // worktree that is ITSELF bound keeps its own binding.
  const here = gitCommonDir(cur);
  if (!here) return undefined;
  // Memoized because this probes OTHER bindings' folders, not just our own, and it runs
  // at every proxy start in every folder a harness opens. One `boundPath` on a stale
  // network mount would otherwise be stat'd repeatedly while it blocks on the mount
  // timeout. Two bindings in one repo is the common case, so the cache earns its keep.
  const repoOf = new Map<string, string | undefined>();
  const commonDirOf = (p: string): string | undefined => {
    if (!repoOf.has(p)) repoOf.set(p, gitCommonDir(p));
    return repoOf.get(p);
  };
  let best: { workspaceId: string; entry: BindingEntry } | undefined;
  for (const hit of byPath.values()) {
    // Cheap rejection first: a binding that cannot beat the current best on recency
    // never needs its folder touched at all.
    if (best && (hit.entry.createdAt ?? 0) <= (best.entry.createdAt ?? 0)) continue;
    // Realpath'd, because `here` is: comparing a resolved path against an unresolved
    // one silently never matches on macOS (`/var` vs `/private/var`).
    const bound = realPath(hit.entry.boundPath!);
    // Same repository, the ordinary case: the bound folder is a worktree (or the main
    // checkout) of this one.
    let match = commonDirOf(bound) === here;
    // Or the bound folder is the one that DIRECTLY CONTAINS this repository's git dir.
    // That is the bare layout — `~/proj/.bare` beside `~/proj/main` — where the folder a
    // person opens and binds, `~/proj`, is not itself a git repo and so has no common
    // dir of its own. Without this, binding the folder they actually look at does
    // nothing and they get the same silent no-tools symptom this issue is about.
    //
    // DIRECT parent, never an ancestor. `dirname("~/proj/.bare") === "~/proj"` matches,
    // while binding `~` and hoping to catch `~/proj/.git` does not — which is the whole
    // point, because that is RTSC-91's cross-org leak.
    if (!match) match = dirname(here) === bound;
    if (!match) continue;
    // Newest wins, the tie-break `byPath` already uses: a folder bound, unbound and
    // bound again leaves an older entry behind, and the fresher one is live.
    best = hit;
  }
  return best;
}

export type ResolvedConn = {
  key: string;
  url: string;
  /**
   * The folder this key was BOUND to, when the key came from the keystore (RTSC-825).
   *
   * Not the same thing as the cwd, and that difference is the whole reason it is
   * returned: `auto` resolves a key by walking UP from the cwd to the bound folder, so
   * a harness started in `~/retasc/dash` uses `~/retasc`'s key. Naming the workspace
   * after the cwd would call that workspace `dash`, and the next session started at the
   * root would rename it `retasc` — one row flapping between the names of every
   * subdirectory anyone opens a terminal in, each flap a billed write. The bound folder
   * is the stable answer, and it is the one the key actually belongs to.
   *
   * Empty when the key did not come from the keystore (a legacy inline key, or an
   * explicit RETASC_MCP_KEY in the environment): those name no folder.
   */
  boundPath: string;
  /**
   * RTSC-1014 — the keystore id this key came from, so the proxy can cache the per-tool
   * credentials it mints under it (`harnessKeys`).
   *
   * Empty on exactly the branches `boundPath` is empty on: a key from the environment or
   * an inline marker belongs to no keystore entry, so there is nowhere to write a cache.
   * Those sessions still get the harness tier — they just re-mint each start, which is
   * the honest cost of a credential that lives nowhere this process can persist to.
   */
  workspaceId: string;
};

/**
 * RTSC-98: the ONE place that resolves a workspace's key + MCP url. Shared by the
 * proxy (env-based) and the direct commands `claim`/`tidy`/`done` (.mcp.json-based)
 * so the two paths can never drift again. Precedence: explicit `RETASC_MCP_KEY`
 * env → legacy inline key in the marker (env or Authorization header) → canonical
 * secret-free marker (`RETASC_WORKSPACE` → home keystore, or `auto` → this
 * process's cwd → home keystore). `mcpEntry` is a
 * workspace `.mcp.json`'s `mcpServers.retasc` entry, or undefined when only the
 * environment carries the binding (the spawned proxy).
 *
 * URL trust pairs with key source (RTSC-262 review, tightened by RTSC-800): a url
 * is honored only when it arrived WITH the key actually used. A keystore-resolved
 * key therefore travels only to the keystore's url — never to one from the entry,
 * and never to one from the environment. Co-located pairs keep their own url,
 * because there the key and url share a trust domain: a legacy inline entry, and
 * an explicit `RETASC_MCP_KEY` + `RETASC_MCP_URL` in the environment.
 *
 * RTSC-800 is why the env url is PAIRED rather than absolute. RTSC-262 made this
 * promise but implemented it on the `mcpEntry` branch only, and the proxy — the
 * one caller that ever reads a committed marker — passes no entry. It hands us
 * `process.env`, which the harness populates from the marker's own `env` block
 * (`mcpMarkerEntry` / `autoMarkerEntry`). So a `RETASC_MCP_URL` planted next to
 * `RETASC_WORKSPACE` in a committed `.mcp.json` arrived as an env url, won, and
 * every teammate's proxy posted its real keystore key to that host on the next
 * harness start. Nothing legitimate loses a path: `bind` stores the deployment's
 * url INTO the binding, so a self-hosted url is already in the keystore by the
 * time the proxy asks for it.
 *
 * This closes the url, and only the url. A hostile committed marker can set any
 * variable for the spawned proxy (`RETASC_DIR` relocates the keystore outright —
 * see `keystoreDir` above — and `NODE_OPTIONS` is arbitrary code) and it chooses
 * the `command` that runs, so a marker you do not trust is
 * code execution by the MCP config format's own design — the harness's project-
 * trust prompt is the boundary for that, not this function. What this removes is
 * the one variant that survives review, because a url string in a config file
 * looks like configuration.
 */
export function resolveConn(opts: {
  env?: NodeJS.ProcessEnv;
  mcpEntry?: any;
  defaultUrl?: string;
  /** Where to resolve an `auto` marker from (RTSC-780). Defaults to the process's
   *  own cwd, which for a spawned stdio server is the folder the harness opened. */
  cwd?: string;
}): ResolvedConn {
  const env = opts.env ?? process.env;
  const entry = opts.mcpEntry;
  let key = env.RETASC_MCP_KEY || "";
  // Paired with the env KEY, not read unconditionally (RTSC-800): without a key
  // beside it, an env url is just a string the committed marker chose, and the key
  // it would redirect belongs to the keystore.
  let url = key ? env.RETASC_MCP_URL || "" : "";

  // Entry-supplied key/url are read together — the url is honored only when
  // the key it's paired with is the one actually used.
  let entryKey = "";
  let entryUrl = "";
  if (entry) {
    if (typeof entry.env?.RETASC_MCP_KEY === "string") entryKey = entry.env.RETASC_MCP_KEY;
    if (typeof entry.env?.RETASC_MCP_URL === "string") entryUrl = entry.env.RETASC_MCP_URL;
    if (!entryUrl && typeof entry.url === "string") entryUrl = entry.url;
    if (!entryKey && typeof entry.headers?.Authorization === "string") {
      const m = String(entry.headers.Authorization).match(/^Bearer\s+(.+)$/i);
      if (m) entryKey = m[1].trim();
    }
  }
  if (!key && entryKey) {
    key = entryKey;
    if (!url) url = entryUrl;
  }

  // Canonical (RTSC-92): secret-free marker → workspace id → home keystore.
  // Neither the entry's url nor the environment's is consulted on this branch —
  // the key came from the keystore, so the url does too (RTSC-800).
  //
  // RTSC-780 adds one more step in front of the id: `auto` names no workspace, so
  // the folder we were spawned in picks it. Same trust rule either way — the key
  // came from the keystore, so it travels only to the keystore's url. That is what
  // lets `auto` be written into a GLOBAL harness config: the entry is identical on
  // every machine and in every folder, and carries nothing worth stealing.
  let boundPath = "";
  let workspaceId = "";
  if (!key) {
    const wsId = env.RETASC_WORKSPACE || entry?.env?.RETASC_WORKSPACE;
    // The ID as well as the entry (RTSC-1014): `auto` resolves one by walking up from the
    // cwd, and the caller cannot recompute which id that was without repeating the walk.
    const hit =
      wsId === AUTO_WORKSPACE
        ? findBindingByPath(opts.cwd ?? process.cwd())
        : wsId
          ? (() => {
              const e = getBinding(String(wsId));
              return e ? { workspaceId: String(wsId), entry: e } : undefined;
            })()
          : undefined;
    const b = hit?.entry;
    if (b) {
      workspaceId = hit!.workspaceId;
      key = b.key;
      // Unconditional, where this used to be `if (!url)`. Equivalent today — reaching
      // here means `key` was empty, and both writes to `url` above are key-gated, so it
      // is empty too — and that is the point: the rule "a keystore key rides the keystore
      // url" is stated here outright rather than left resting on that invariant, so
      // restoring an unpaired url above cannot quietly resurrect the RTSC-800 redirect.
      url = b.url;
      boundPath = b.boundPath ?? "";
    }
  }

  return { key, url: url || opts.defaultUrl || "", boundPath, workspaceId };
}
