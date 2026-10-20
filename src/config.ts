import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  chmodSync,
  openSync,
  closeSync,
  writeSync,
  statSync,
  readdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

// Production defaults. Overridable via env for dev/testing.
//   RETASC_DEPLOYMENT_URL — Convex deployment (.cloud) for management calls
//   RETASC_MCP_URL        — the MCP endpoint agents connect to
//   RETASC_DASH_URL       — the Dash, for the browser sign-in round trip (RTSC-691)
export const DEFAULTS = {
  deploymentUrl: process.env.RETASC_DEPLOYMENT_URL ?? "https://unique-lyrebird-934.convex.cloud",
  mcpUrl: process.env.RETASC_MCP_URL ?? "https://mcp.retasc.com/mcp",
  dashUrl: process.env.RETASC_DASH_URL ?? "https://dash.retasc.com",
};

export type StoredUser = { id: string; name?: string; email?: string };

/** Which sign-in door a login went through. Mirrors `LoginProvider` in auth.ts,
 *  declared here so config.ts stays free of an import cycle (auth reads config). */
export type StoredLoginProvider = "github" | "google";

export type Config = {
  deploymentUrl: string;
  mcpUrl: string;
  // Where the browser sign-in round trip goes (RTSC-691). Not a secret and not
  // per-workspace; it tracks `deploymentUrl` and exists so a dev deployment can point
  // its CLI at a local Dash.
  dashUrl: string;
  token?: string; // Convex Auth session JWT
  refreshToken?: string;
  user?: StoredUser;
  defaultOrgId?: string;
  defaultProjectPrefix?: string;
  // RTSC-508: the door the LAST SUCCESSFUL login used, so the next one can offer
  // it as the default. Only ever written after a sign-in actually completed — it
  // is a record of what worked for this human, never a guess about them.
  loginProvider?: StoredLoginProvider;
  // RTSC-879 — a device grant that has been STARTED and not yet approved, so an
  // agent-driven `bind` can print the code, exit, and resume on the next call.
  //
  // IT IS A CREDENTIAL, short-lived and single-use. Under RFC 8628 the `client_id` is
  // public, so anyone who can read `deviceCode` during the pending window can poll the
  // token endpoint and redeem the upstream token the moment the human approves. It lives
  // in the same 0600 file as the session token, which `saveConfig` creates under a 0700
  // directory, and it is cleared on completion and on terminal failure. The upstream
  // access token is never written here at all: `deviceFinish` holds it locally and
  // persists only the Convex session.
  pendingDevice?: {
    provider: StoredLoginProvider;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    intervalMs: number;
    expiresAt: number;
    /** Which backend this grant was started against. A Google grant is polled through
     *  Convex, so resuming it against a different deployment would ask the wrong server
     *  about a code it never issued. */
    deploymentUrl?: string;
    /** The ad click ref the printed link carries (cli/src/lib/adClick.ts). */
    clickRef?: string;
  };
  // RTSC-523: whether this human wants `retasc` installed on their machine, asked
  // once during setup. Remembered because it is a question about the MACHINE, and
  // the machine has not changed by the time they bind a second folder.
  //
  // Absent means never asked. `false` is the load-bearing value: someone who
  // declined must not be re-asked on every project, and their marker keeps naming
  // npx. `true` is rarely read, because an install that worked leaves `retasc` on
  // PATH, and then there is nothing left to decide.
  globalInstall?: boolean;
  // RTSC-520: when the update notice was last SHOWN (epoch ms). One stamp covers both
  // rules the notice has to obey — at most once a day, and a decline is not re-asked on
  // the next command — because both are the same question: has this human already been
  // told today? Stamped when the notice is PRINTED, not when they answer, so declining
  // and dismissing cost the same silence.
  updateNoticeAt?: number;
  // RTSC-1153 — the CLI keeps itself current. Absent means ON, the default; only an
  // explicit `false` (from `retasc config auto-update off`) turns it off.
  autoUpdate?: boolean;
  // RTSC-1153 — when a background update was last STARTED (epoch ms): the daily throttle.
  autoUpdateAt?: number;
  // RTSC-1153 — what the last background update did, for `doctor` and for the proxy to
  // report a failure so the server's stale-CLI notice can take over.
  autoUpdateResult?: AutoUpdateResult;
  // RTSC-1153 — when this machine was told that updates are automatic. Once, ever.
  autoUpdateNoticeAt?: number;
  // RTSC-1153 — when a background check last COMPLETED: npm answered and the machine was
  // brought current or already was. Distinct from `autoUpdateAt`, which is only when one
  // was started, so "started every day, never got an answer" is visible.
  autoUpdateCheckedAt?: number;
  // RTSC-1153 — when the first check was started that has not yet completed. Set when a
  // day's attempt starts and none is pending; cleared when a check completes. Staleness is
  // measured from it, never from the wall clock, so a machine left idle over a weekend is
  // not "failing" on Monday: it has only just started trying again.
  autoUpdatePendingSince?: number;
};

export type AutoUpdateResult = { at: number; from: string; to?: string; ok: boolean; error?: string };

/** The dir config lives in. RETASC_DIR overrides it (tests, sandboxes) — same
 *  knob the keystore reads, so the two stay co-located. */
function configDir(): string {
  return process.env.RETASC_DIR || join(homedir(), ".retasc");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** RTSC-1153 — the stored result, or nothing. Strings are length-capped: the error is
 *  sent to the server and printed by `doctor`. */
function autoUpdateResultOf(v: unknown): AutoUpdateResult | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const at = finite(r.at);
  const str = (x: unknown) => (typeof x === "string" && x.length <= 32 ? x : undefined);
  const from = str(r.from);
  if (at === undefined || from === undefined || typeof r.ok !== "boolean") return undefined;
  const to = str(r.to);
  const error = typeof r.error === "string" ? r.error.slice(0, 200) : undefined;
  return { at, from, ok: r.ok, ...(to ? { to } : {}), ...(error ? { error } : {}) };
}

export function loadConfig(): Config {
  const FILE = configPath();
  let stored: Partial<Config> = {};
  if (existsSync(FILE)) {
    let raw: string | undefined;
    try {
      raw = readFileSync(FILE, "utf8");
    } catch {
      // A read that FAILS (file lock, EIO, EMFILE, stale NFS handle) is transient,
      // not corruption. Leave the file untouched and fall back to defaults for this
      // run — self-heal next time — rather than renaming a possibly-valid config
      // aside and turning a blip into a permanent logout.
      raw = undefined;
    }
    if (raw !== undefined) {
      try {
        stored = JSON.parse(raw);
      } catch {
        // Read succeeded but the bytes aren't valid JSON → genuinely corrupt/
        // truncated (e.g. an interrupted write). Preserve them under a backup name
        // rather than silently discarding — the file may still hold the only copy
        // of the user's tokens, recoverable by hand. Then start fresh.
        backupCorruptConfig(FILE);
        stored = {};
      }
    }
  }
  // Defaults fill in; a saved value always wins.
  return {
    deploymentUrl: stored.deploymentUrl ?? DEFAULTS.deploymentUrl,
    mcpUrl: stored.mcpUrl ?? DEFAULTS.mcpUrl,
    dashUrl: stored.dashUrl ?? DEFAULTS.dashUrl,
    token: stored.token,
    refreshToken: stored.refreshToken,
    user: stored.user,
    defaultOrgId: stored.defaultOrgId,
    defaultProjectPrefix: stored.defaultProjectPrefix,
    // Validated on read, not trusted: this value decides which door a bare Enter
    // takes, and the file is hand-editable. Anything unrecognised reads as "never
    // recorded", which falls back to asking outright.
    loginProvider:
      stored.loginProvider === "github" || stored.loginProvider === "google"
        ? stored.loginProvider
        : undefined,
    // Same rule (RTSC-523): only a real boolean counts. Anything else reads as
    // "never asked", so a mangled file leads to a question rather than to an
    // install nobody agreed to.
    globalInstall: typeof stored.globalInstall === "boolean" ? stored.globalInstall : undefined,
    // Same rule again (RTSC-520): a hand-edited or mangled value reads as "never shown".
    // Finite, because `NaN`/`Infinity` survive JSON round-trips through some editors and
    // would make the once-a-day gate either permanently open or permanently shut.
    updateNoticeAt:
      typeof stored.updateNoticeAt === "number" && Number.isFinite(stored.updateNoticeAt)
        ? stored.updateNoticeAt
        : undefined,
    // RTSC-1153 — same rules. Only a real boolean counts, so a mangled value leaves the
    // default (on) rather than silently stopping updates.
    autoUpdate: typeof stored.autoUpdate === "boolean" ? stored.autoUpdate : undefined,
    autoUpdateAt: finite(stored.autoUpdateAt),
    autoUpdateResult: autoUpdateResultOf(stored.autoUpdateResult),
    autoUpdateNoticeAt: finite(stored.autoUpdateNoticeAt),
    autoUpdateCheckedAt: finite(stored.autoUpdateCheckedAt),
    autoUpdatePendingSince: finite(stored.autoUpdatePendingSince),
    // RTSC-879 — and it MUST be here. `loadConfig` rebuilds the object field by field, so
    // a field absent from this literal is invisible to every reader no matter what is on
    // disk. Left out, `bind --json` never saw the grant it had just written: it minted a
    // fresh code on every call, invalidating the one the human was reading, and exited 0
    // forever. The whole suite stayed green because nothing round-tripped the grant
    // through the config, which is why the test below does exactly that.
    //
    // Validated, same rule as the fields above: the file is hand-editable, and this one
    // is fed straight to a polling loop. An unrecognised provider must not fall through
    // to GitHub's branch by default, and a non-finite `expiresAt` would make the grant
    // either immortal or already dead.
    pendingDevice: readPendingDevice(stored.pendingDevice),
  };
}

/** A stored device grant, or `undefined` if it is anything other than a complete one. */
function readPendingDevice(v: any): Config["pendingDevice"] {
  if (!v || typeof v !== "object") return undefined;
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : undefined);
  const provider = v.provider === "github" || v.provider === "google" ? v.provider : undefined;
  const deviceCode = str(v.deviceCode);
  const userCode = str(v.userCode);
  const verificationUri = str(v.verificationUri);
  const expiresAt =
    typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt) ? v.expiresAt : undefined;
  if (!provider || !deviceCode || !userCode || !verificationUri || expiresAt === undefined) {
    return undefined;
  }
  // A negative or absent interval would busy-poll a provider that asked us not to.
  const intervalMs =
    typeof v.intervalMs === "number" && Number.isFinite(v.intervalMs) && v.intervalMs > 0
      ? v.intervalMs
      : 5000;
  return {
    provider,
    deviceCode,
    userCode,
    verificationUri,
    ...(str(v.verificationUriComplete)
      ? { verificationUriComplete: v.verificationUriComplete as string }
      : {}),
    intervalMs,
    expiresAt,
    ...(str(v.deploymentUrl) ? { deploymentUrl: v.deploymentUrl as string } : {}),
    ...(str(v.clickRef) ? { clickRef: v.clickRef as string } : {}),
  };
}

/** Move a corrupt config aside to a unique sibling so a human can recover any
 *  tokens it still holds. Best effort — never throw from the load path. */
function backupCorruptConfig(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${randomUUID()}`);
  } catch {
    /* best effort — if we can't back it up, saveConfig will overwrite it */
  }
}

export function saveConfig(cfg: Config): void {
  const dir = configDir();
  const FILE = configPath();
  // Create the dir user-only and the temp file 0600, so tokens never exist
  // world-readable even briefly (the chmod below only closes a pre-existing
  // 0644 file — it can't undo a world-readable creation window).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Atomic write: fully write a sibling temp file, then rename it over the real
  // one. rename(2) is atomic on POSIX, so a crash or an interleaved write leaves
  // either the old complete config or the new one — never a truncated file that
  // loadConfig would read as "logged out". The temp lives in the same dir so the
  // rename stays on one filesystem (a cross-device rename is not atomic).
  const tmp = join(dir, `.config.json.${randomUUID()}.tmp`);
  const body = JSON.stringify(cfg, null, 2) + "\n";
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600); // keep user-only if a umask/prior file loosened it
    } catch {
      /* best effort (e.g. Windows) */
    }
    renameSync(tmp, FILE);
  } catch (err) {
    // Don't leave a stray temp file behind on failure.
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
  // Best-effort GC of temp siblings orphaned by a hard kill (SIGKILL / power loss)
  // between writeFileSync(tmp) and renameSync above — otherwise they accumulate in
  // ~/.retasc forever across crashes. Runs after our own rename so our temp is
  // already gone. Age-gated (see sweepStaleTemps) so it never touches a concurrent
  // writer's in-flight temp.
  sweepStaleTemps(dir);
}

/** A temp sibling this much older than now was orphaned by a crash, not left by a
 *  live writer — any real writeFileSync→renameSync window is milliseconds. */
const TEMP_STALE_MS = 60_000;

/** Delete `.config.json.<uuid>.tmp` leftovers only once they're demonstrably stale,
 *  so an unconditional sweep can't race-delete a concurrent writer's fresh temp
 *  (which would reintroduce the very lost-update class this file guards against). */
function sweepStaleTemps(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir vanished / unreadable — nothing to sweep
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(".config.json.") || !name.endsWith(".tmp")) continue;
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > TEMP_STALE_MS) unlinkSync(p);
    } catch {
      /* raced another sweeper or a writer's own rename — fine, leave it */
    }
  }
}

// --- Cross-process config lock -------------------------------------------------
// saveConfig is byte-atomic (temp + rename) but that is NOT isolation: two
// concurrent load→modify→save sequences both read the old file and the last
// rename wins, silently dropping the other's fields (RTSC-250). The dangerous
// case: a `defaultProjectPrefix` write that began before a token refresh writes
// back the OLD single-use refreshToken, so the next refresh fails and a
// non-interactive MCP context can't re-run the device flow. An advisory lock file
// serializes the whole read-modify-write across processes, so every patcher
// re-reads the freshest config (including a just-rotated token) before writing.
//
// Assumes a coherent LOCAL clock: the staleness heuristic compares a lock file's
// mtime (set by the host that created it) against this host's Date.now(). That
// holds for the intended case — several processes on ONE machine sharing one
// ~/.retasc. On a network home with a skewed server clock it degrades to
// best-effort (over-eager or over-lazy stealing); we don't target that here.
// Any whole-file mutating writer MUST go through patchConfig so it takes the
// lock — saveConfig alone is not self-locking (logout's delete is the one benign
// exception: racing a refresh there is a user-intent race, not a durability bug).

/** A lock whose mtime is older than this belongs to a holder that died without
 *  releasing it (a crash leaves the O_EXCL file behind); break it so a crash
 *  can't wedge every future patch forever. Far larger than any real hold, which
 *  is a synchronous read+write of a tiny file (single-digit ms). */
const LOCK_STALE_MS = 30_000;
/** Absolute backstop: if staleness somehow never frees the lock, force it after
 *  this. Kept ABOVE the stale threshold so normal breaking is governed by
 *  staleness, not by a timer that could guillotine a merely-slow live holder. */
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_BACKOFF_MS = 25;

/** Block this (single) thread for `ms` without busy-spinning. Node is
 *  single-threaded; the lock we wait on is released by ANOTHER process, so
 *  parking the thread is correct — nothing here could release it. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The current holder's identity + age, or undefined if the lock just vanished. */
function readLockHolder(lockPath: string): { nonce: string; ageMs: number } | undefined {
  try {
    const nonce = readFileSync(lockPath, "utf8");
    return { nonce, ageMs: Date.now() - statSync(lockPath).mtimeMs };
  } catch {
    return undefined; // gone between our failed create and this read → just retry
  }
}

/** Run `fn` holding an exclusive on-disk lock, so its read-modify-write of the
 *  config can't interleave with another process's. Each acquirer stamps a unique
 *  nonce into the lock file; steal and release only ever remove a lock whose nonce
 *  still matches the one we observed, so a holder that was judged stale and had its
 *  lock stolen can't later delete the DIFFERENT holder's lock (which would collapse
 *  mutual exclusion back into the lost-update this whole mechanism prevents). */
function withConfigLock<T>(fn: () => T): T {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, ".config.json.lock");
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      // "wx" = O_CREAT | O_EXCL | O_WRONLY — atomically fails if the lock is held.
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, nonce); // stamp our identity so steal/release can verify it
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockHolder(lockPath);
      if (!holder) continue; // vanished → retry the create immediately
      if (holder.ageMs > LOCK_STALE_MS || Date.now() > deadline) {
        // Dead holder (stale) or backstop expired: break THIS holder's lock only.
        // If a fresh acquirer replaced it since our read, the nonce differs and we
        // leave it — never steal a live lock out from under a new owner.
        breakLockIf(lockPath, holder.nonce);
        continue;
      }
      sleepSync(LOCK_BACKOFF_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    // Only remove the lock if it's still OURS. If we were stolen from while stalled,
    // the file now holds another holder's nonce — leave it for them.
    breakLockIf(lockPath, nonce);
  }
}

/** Unlink the lock only if it still carries `nonce` — a nonce-checked delete, so
 *  we never remove a lock a different process now owns. */
function breakLockIf(lockPath: string, nonce: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === nonce) unlinkSync(lockPath);
  } catch {
    /* already gone, replaced, or unreadable — nothing safe to do */
  }
}

/**
 * RTSC-1153 — read, decide and write in ONE critical section. `decide` gets the config as
 * it is on disk right now and returns a patch to apply, or null to leave it. This is what
 * makes "start one background update a day" hold when several sessions start at once: a
 * separate read then `patchConfig` would let every one of them see the old stamp.
 */
export function updateConfigIf(decide: (cfg: Config) => Partial<Config> | null): boolean {
  return withConfigLock(() => {
    // An unreadable file (a lock, EIO) makes `loadConfig` fall back to DEFAULTS so a
    // blip is not a logout. Writing those defaults back WOULD be one, and this runs
    // unattended from the proxy and the hook, so it declines instead.
    if (!configReadable()) return false;
    const cur = loadConfig();
    const patch = decide(cur);
    if (!patch) return false;
    saveConfig({ ...cur, ...patch });
    return true;
  });
}

/** RTSC-1153 — can the config file be read right now? Absent counts as readable (it is
 *  simply empty). `loadConfig` hides a read failure behind defaults, which is right for a
 *  command and wrong for anything that would act on, or report, what those defaults say. */
export function configReadable(): boolean {
  try {
    if (existsSync(configPath())) readFileSync(configPath(), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function patchConfig(patch: Partial<Config>): Config {
  // Load AND save under the lock: re-reading inside the critical section is what
  // makes this safe — a patch that only sets `defaultProjectPrefix` still picks up
  // a refreshToken another process rotated a moment ago, instead of clobbering it.
  return withConfigLock(() => {
    const next = { ...loadConfig(), ...patch };
    saveConfig(next);
    return next;
  });
}

export function isLoggedIn(cfg = loadConfig()): boolean {
  return Boolean(cfg.token);
}
