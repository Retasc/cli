// Liveness watchdog proxy (RTSC-44). A stdio MCP server the harness (Claude Code,
// Codex, OpenCode, …) spawns. It transparently forwards every JSON-RPC message to
// the remote Retasc MCP over HTTP and — by watching claim tokens in the responses —
// keeps claimed issues' leases alive with out-of-band `heartbeat` calls. The LLM
// never heartbeats. Fail-safe: if this process dies, heartbeats stop and the server
// reclaims the lease (the correct default) — a broken watchdog is never worse than
// no watchdog. Self-enforcing: no proxy → no Retasc tools → can't orphan a lease.

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyObservation,
  heartbeatRequest,
  isClaimLost,
  isToolError,
  isUnauthorized,
  isSessionKeyExpired,
  isClaimObservation,
  shouldReapOnClose,
  untrackedLeaseWarning,
  type Leases,
} from "./lib/watchdog.js";
import { AUTO_WORKSPACE, resolveConn, rememberHarnessKey, getBinding } from "./lib/keystore.js";
import { toolResult as parseTool } from "./lib/toolresult.js";
import { transcriptKeepDays } from "./lib/transcriptKeep.js";
import { findPiTranscript } from "./lib/piSession.js";
import { mintSessionKey, mintHarnessKey, appendFallbackNotice, recordSession, nameWorkspace, RPC_ID } from "./lib/session.js";
import { healHookEntries, sharedWindowNotice, processAlive, readHookRecord, clearHookRecord, modelFromTranscript, readHarnessRecord, removeLeaseFile, writeLeaseFile, leaseNotice, readOrphanedLeases, readWindowConversation } from "./lib/sessionHook.js";
import { findWindowPid, parseAncestry } from "./lib/conversation.js";
import { VERSION } from "./version.js";
import { configReadable, loadConfig } from "./config.js";
import { ensurePiKeepAlive } from "./lib/harness.js";
import { onDurablePath } from "./lib/launcher.js";
import { autoMarkerEntry } from "./commands/setup.js";
import { attachAutoUpdateNotice, autoUpdateState, claimAutoUpdateSlot, maybeStartAutoUpdate, reportedStatus, spawnDetachedUpdate, takeAutoUpdateNotice } from "./lib/autoUpdate.js";
import {
  attachRoot,
  isLocalAttachCall,
  mergeAttachTool,
  readAttachFile,
  resolveAttachPath,
  uploadFailureMessage,
  uploadUrlWith,
} from "./lib/attachFile.js";
import {
  buildReport,
  candidateTrees,
  holdsFrom,
  holdsToAnnounce,
  reportRequest,
  unclaimedNotice,
  type TreeState,
} from "./lib/worktreeReport.js";
import {
  MAX_FETCH_BYTES,
  downloadFailureMessage,
  existingDownload,
  isLocalFetchCall,
  mergeFetchTool,
  prepareDownloadDir,
  resolveDownloadTarget,
  writeDownloadedFile,
} from "./lib/fetchFile.js";

// RTSC-92/98: resolve the workspace key via the SHARED resolver, so the proxy and
// the direct commands (claim/tidy/done) can never diverge. The proxy carries its
// binding in its own env (RETASC_MCP_KEY legacy, or RETASC_WORKSPACE → keystore).
const resolved = resolveConn({ env: process.env, defaultUrl: "https://mcp.retasc.com/mcp" });
let MCP_URL = resolved.url;
const KEY = resolved.key;

// RTSC-780: with the `auto` marker the SAME entry is wired into every harness, once, and
// is therefore present in folders that were never bound. That is no longer a broken
// install, it is the ordinary state of a folder you haven't run `retasc bind` in yet, so
// it needs an answer rather than a 401.
//
// Getting this wrong is what RTSC-781 is about. Forwarding keyless requests produces an
// auth failure, and the CLI's own login is global and still fine, so the agent reports
// "signed in, but the server is unreachable" and a human goes and checks a server that
// was serving other clients the whole time. The folder is the thing that is missing, so
// the folder is what the error has to name.
const UNBOUND =
  !KEY && (process.env.RETASC_WORKSPACE ?? "") === AUTO_WORKSPACE ? process.cwd() : null;

const UNBOUND_MESSAGE =
  `This folder (${UNBOUND ?? process.cwd()}) is not bound to a Retasc project, so there is ` +
  `nothing to pull work from. Nothing is wrong with your sign-in or with the Retasc server. ` +
  `Run \`retasc bind\` in this folder to say which org and project it belongs to, then restart ` +
  `this agent so it picks the binding up.`;
const HEARTBEAT_MS = Number(process.env.RETASC_HEARTBEAT_MS) || 10 * 60 * 1000;

const leases: Leases = new Map();
let hbSeq = -1; // out-of-band heartbeat ids are negative — never collide with the harness's

// RTSC-1150 — the Claude Code process we run under, once a hook record names it; until
// when the server last CONFIRMED each lease (a claim or a heartbeat that succeeded); and
// the list last written for the window's hook. See lib/conversation.ts.
let harness: number | null = null;
// This process's ancestors, nearest first. Read once, lazily: only a Claude Code session
// ever needs it, and `ps` is a synchronous child the other harnesses should not pay for.
let ancestors: number[] | null = null;
let psWarned = false;
const leaseUntil = new Map<string, number>();
const LEASE_TTL_MS = 30 * 60 * 1000; // CLAIM_TTL_MS server-side; used when a reply names no expiry
let leaseFileWritten = "";
let leaseFileHarness: number | null = null;

// RTSC-962 — the worktree census. The server cannot read git and never will; this
// process can, and a `rtsc-NN/<slug>` worktree is an agent saying in the filesystem
// "I am working on RTSC-NN". Reporting it lets the queue SEE work somebody started
// without claiming, which is the one transition Retasc had no gate for.
//
// Throttled: `git worktree list` is milliseconds, but a `git status` per tree is not,
// on a large repo — and this is triggered by the agent's tool calls, which can arrive
// several a second.
const WORKTREE_SCAN_MS = Number(process.env.RETASC_WORKTREE_SCAN_MS) || 30_000;
let lastWorktreeScan = 0;
// Issue → branch for the holds the server last confirmed, so the notice can name the
// branch. Rebuilt from each scan: a hold that has been claimed (or has lapsed) drops
// off the server's list and must stop being announced.
let activeHolds = new Map<string, string>();
// Holds already announced to the agent. ONCE PER HOLD, not once per call.
//
// The temptation is to repeat the line until the agent acts, and it is the wrong
// instinct — it is the exact failure the server-side riders are written against
// (RTSC-463: "a paragraph repeated on every claim becomes wallpaper"). A hold stands for
// an hour, during which an agent can easily make a hundred tool calls; a line on every
// one of them does not get more obeyed, it gets skipped, and it teaches the agent to
// skip the NEXT one too. Saying it once is what keeps it readable — and the case that
// actually matters, a reader about to act on the issue, is caught again server-side by
// the `get_issue` rider, which has the full context to say something useful.
//
// Cleared when a hold goes away, so a genuinely new sighting of the same issue later
// speaks up again.
const announcedHolds = new Set<string>();
// One scan at a time. The throttle alone is not enough: a scan that outruns the window
// (a slow disk, a huge repo) would otherwise overlap with the next one and multiply the
// git processes it was meant to bound.
let scanning = false;

/**
 * One git command, ASYNC, returning stdout — or null if git failed or could not be run.
 *
 * Deliberately not `spawnSync`, which the rest of this file uses for its one-shot
 * startup probe. This runs every 30 seconds for the life of the session, and the proxy
 * is a stdio relay: a synchronous child blocks the event loop, so every message in
 * flight — the agent's own tool calls included — waits for git. Never rejects; a census
 * that cannot read the disk says nothing rather than failing anything.
 */
function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveOut) => {
    let out = "";
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOut(v);
    };
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    // A git that hangs (a credential prompt, a network remote, a stuck lock) must not
    // wedge the census — same reasoning as REAP_TIMEOUT_MS, shorter because these are
    // local, read-only commands that should take milliseconds.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, 5_000);
    timer.unref?.();
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? out : null));
  });
}
// RTSC-646: the credential-death warning fires ONCE with its full explanation. A
// revoked/rotated key fails every heartbeat of every lease, so repeating the whole
// paragraph on each tick (every 10 min, per lease) would bury the first one.
let authWarned = false;
// Per-session key (RTSC-50): starts as the workspace key; on startup we mint a
// session key and switch to it so this session is distinguishable from others.
let activeKey = KEY;
/**
 * RTSC-1194 — the credential `activeKey` was minted FROM (this tool's harness key, or the
 * workspace key). Kept so a session key the server has since revoked can be replaced by
 * a fresh one from the same parent, without a restart. Unset while running on `KEY`.
 */
let sessionParent: string | undefined;
// RTSC-820 — the harness's transcript id, once we learn it, and whether the server has
// it. Grok exports GROK_SESSION_ID to MCP servers, so that one is known at startup.
// Claude Code hands its id to a SessionStart HOOK, which drops a record in the keystore
// dir (lib/sessionHook.ts); hook and proxy start in either order, so the record is
// looked for after the mint and then on each forwarded call until found, bounded.
const PROXY_STARTED_AT = Date.now();
const TRANSCRIPT_LOOKUPS_MAX = 40;
let transcript: { id: string; harness: string; model?: string; agentType?: string; agentId?: string } | null =
  process.env.GROK_SESSION_ID ? { id: process.env.GROK_SESSION_ID, harness: "grok" } : null;
/**
 * RTSC-1080 — WHO IS RUNNING US, when the handshake did not say.
 *
 * The harness is normally learned from `clientInfo.name` at `initialize`. A client that
 * sends none is not hypothetical: Pi has no MCP client by design (its README: "No MCP"),
 * so a Pi session reaches Retasc the way `workflow.md` already anticipates for "a
 * hand-rolled client" — it spawns this proxy from its shell tool and speaks JSON-RPC
 * down stdin by hand. That works. RTSC-1077 was filed exactly that way.
 *
 * What did NOT work is the attribution. With no `clientInfo`, the workspace's remembered
 * harness key was adopted instead, and Pi's issue landed on the books as Claude Code's.
 * A wrong harness is worse than an unknown one: "no adapter yet" says look elsewhere,
 * while a confident `claude-code` row sends a reader to the wrong machine and the wrong
 * transcript.
 *
 * `AI_AGENT` is what fixes it, and it is the same shape as the GROK_SESSION_ID line
 * above: a harness that puts its identity in the ENVIRONMENT needs no adapter. Pi sets
 * `AI_AGENT=pi` and `PI_CODING_AGENT=true` in the environment of the shell tool it
 * spawns children from, so a proxy launched there inherits it — measured on pi 0.74.2 —
 * and a client writing JSON by hand cannot get it wrong.
 *
 * AN ALLOWLIST, NEVER AN ECHO. `AI_AGENT` is a generic marker any tool may set, and
 * treating an arbitrary string as a harness name would let an unknown process name
 * itself anything on the Agents page. Only values the server can actually resolve
 * belong here (`RuntimeClass` in convex/lib/runtime.ts).
 */
const ENV_HARNESSES: Record<string, string> = { pi: "pi" };
/**
 * RTSC-1084 — IS THE THING ON THE OTHER END PI?
 *
 * Two independent signals, and it takes either, because neither is reliable alone.
 *
 * `AI_AGENT=pi` is set in the environment of Pi's SHELL TOOL, so a proxy Pi launched
 * from bash inherits it. But the supported path does not go through bash at all:
 * `pi-mcp-adapter` is an EXTENSION running inside Pi's own process, and the proxy it
 * spawns is that process's child, which does not carry the shell tool's environment.
 * Measured — the first cut of this gate checked `AI_AGENT` alone and never fired on a
 * real adapter session.
 *
 * What the adapter DOES give us is its handshake: `clientInfo.name` arrives as
 * `pi-mcp-<server>` (`pi-mcp-retasc` here), which is the same prefix the server resolves
 * through `runtimeClass`. So the client naming itself is the signal that works on the
 * path people actually use, and the environment is the one that works when Pi drives us
 * from a shell by hand.
 */
function isPiClient(name: string | null, env: string | undefined): boolean {
  if (env === "pi") return true;
  const n = (name ?? "").trim().toLowerCase();
  // Exact, or the adapter's server-dependent prefix — never a bare `includes`, since
  // "pi" lives inside copilot, rapid and pilot (the rule convex/lib/runtime.ts keeps).
  return n === "pi" || n.startsWith("pi-coding-agent") || n.startsWith("pi-mcp-");
}
const envHarness: string | undefined = ENV_HARNESSES[(process.env.AI_AGENT || "").trim().toLowerCase()];
let transcriptRecorded = false;
// RTSC-821 — the model we last told the server. A `/model` mid-session rewrites the
// hook record, and re-reporting is how that reaches the Dash, so recording the id is no
// longer the end of this proxy's interest in the record.
let reportedModel: string | undefined;
let lastModelCheckAt = 0;
let pendingModel: string | undefined;
const MODEL_CHECK_INTERVAL_MS = 3_000;
let transcriptLookups = 0;
let transcriptInFlight: Promise<void> | null = null;
// The name the client gave at `initialize` (RTSC-717), so a Codex session started in a
// folder never adopts a claude-code hook's record.
let clientName: string | null = null;
// A hook record is this session's only if written within a minute BEFORE we started or
// a few minutes after; and a session that has not found one in five minutes never will.
/** RTSC-1084 — how far BACK a Pi transcript may be and still be this session. The
 *  adapter spawns us on the first tool call, which can be minutes into a conversation,
 *  so the file predates us; `notBefore` still refuses one from an earlier session in the
 *  same folder. Generous on purpose — a person talks to Pi before asking it for work. */
const PI_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const RECORD_NOT_AFTER_MS = 3 * 60_000;
const RECORD_SEARCH_MS = 5 * 60_000;

// Set when session-key minting failed and we fell back to the workspace key —
// whoami responses get a warning block appended so the agent sees the degraded state.
let sessionKeyFallback = false;
// RTSC-1014 — the harness tier runs ONCE per session, at the handshake. A client that
// sends `initialize` twice (a reconnect inside one process) must not mint a second
// credential, and a client that never sends it keeps the workspace key it started on.
let harnessAdopted = false;
// The tool this session is, when the server has RETIRED it here. Set means: serve
// nothing. Falling back to the workspace key instead would leave a retired tool running
// on the folder's shared credential — the retire, silently undone.
let harnessRetired: string | null = null;

// RTSC-660: the directory a `save_attachment_file` path must live under. Resolved ONCE at
// startup, not per call, so the boundary can't be moved mid-session by anything the model says.
const ATTACH_ROOT = attachRoot(process.env, process.cwd());

// stderr only: stdout is the MCP channel and must carry ONLY protocol messages.
function log(msg: string): void {
  process.stderr.write(`[retasc-watchdog] ${msg}\n`);
}

// RTSC-181: closing an issue over MCP (save_issue status:done) marks it done on the
// control plane but the server never touches git — so the branch/worktree orphans.
// The proxy is the local hands: when it sees a session's own claim close terminally,
// it reaps that issue's branch out-of-band via the CLI's existing `tidy --prune`,
// which reuses every safety guard (skips dirty/unmerged/current-branch). Resolved
// once at startup; null if we're not in a git repo (nothing to reap).
const MAIN_CHECKOUT = resolveMainCheckout();
// The compiled CLI entrypoint (dist/index.js) — resolved relative to this module so
// it's correct however the proxy was launched (not process.argv, which a wrapper
// could rewrite). Reaps re-invoke it as `retasc tidy`.
const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

/** RTSC-1153 — whether this proxy has had its one go at the one-time notice. */
let autoUpdateNoticeTried = false;

/** RTSC-1153 — when this proxy started, for telling an update that landed BEFORE it (and
 *  should be running here) from one that landed after. */
const STARTED_AT = Date.now();

/** RTSC-1153 — what this machine's auto-update is doing, for `mint_session_key`. Read
 *  fresh each mint: the background update may have finished since the last one. */
function autoUpdateReport(): "on" | "off" | "failed" | undefined {
  try {
    // `loadConfig` answers an unreadable file with defaults, which carry no history and
    // would read as a healthy "on". Unknown is sent as nothing instead.
    if (!configReadable()) return undefined;
    const cfg = loadConfig();
    return reportedStatus(VERSION, autoUpdateState(process.env, cfg), cfg, STARTED_AT);
  } catch {
    // Unknown is sent as nothing, which the server treats as an old proxy: it may warn.
    // Never claim "on" for a machine we could not even read.
    return undefined;
  }
}
// Issues whose reap child is in flight — so a duplicate/retried close doesn't spawn
// two concurrent teardowns racing on the same branch.
const reaping = new Set<string>();
// Reaps are SERIALIZED through this chain: concurrent `tidy` children mutating the
// same main checkout contend on `.git` locks (index.lock, ref locks) — a wave-close
// (next_batch → N × save_issue done) would otherwise fire N parallel worktree/branch
// deletes and hit "cannot lock ref" errors + partial teardown. One at a time avoids it.
let reapChain: Promise<void> = Promise.resolve();
const REAP_TIMEOUT_MS = 60_000; // a stuck git (e.g. a credential prompt) must not wedge the queue

// RTSC-1042 — has this session's worktree sweep been queued yet? Once per session, on
// the first claim: that is the moment merges from earlier rounds have landed, and the
// moment just before this agent allocates another tree of its own.
let swept = false;
// The sweep resolves up to AUTO_MAX issue statuses over the network before it touches
// git, where a scoped reap resolves one. Same kind of work, more round trips, so it
// gets its own ceiling rather than borrowing a timeout tuned for a single branch.
const SWEEP_TIMEOUT_MS = 120_000;

/** The main checkout root (worktree/branch ops always target it), or null if not in
 *  a git repo. `--git-common-dir` resolves to the MAIN `.git` even from a worktree. */
function resolveMainCheckout(): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const commonDir = (r.stdout ?? "").trim();
  return commonDir ? dirname(resolve(commonDir)) : null;
}

/**
 * Reap a terminally-closed issue's branch/worktree, out-of-band (RTSC-181). Enqueues
 * a `retasc tidy --prune --only <id>` run (serialized — see `reapChain`) as a SEPARATE
 * process rooted at the main checkout so (a) blocking git never stalls the proxy's
 * stdio loop, and (b) cwd is the main checkout, not the agent's worktree — so `tidy`'s
 * "you're inside its worktree" guard doesn't skip the very tree we mean to remove.
 * `tidy` still enforces every safety check: an unmerged (or dirty) branch is left as an
 * orphan, never force-deleted — so only a clean, merged worktree is ever removed.
 */
function reapClosedIssue(issueId: string): void {
  if (!MAIN_CHECKOUT) return; // not in a git repo — nothing local to reap
  if (reaping.has(issueId)) return; // a teardown for this issue is already queued/running
  reaping.add(issueId);
  // Chain after any in-flight reap so git ops on the shared checkout never overlap.
  reapChain = reapChain.then(() => runReap(issueId));
}

/**
 * RTSC-1042 — sweep this machine's dead worktrees, once per session, on the first claim.
 *
 * The on-close reap (above) asks "is this branch merged?" at the only moment it is
 * guaranteed not to be: `done` is called when the PR opens, and a human merges it
 * afterwards — 4.5 hours later for RTSC-838, the case this was measured on. `tidy`
 * correctly classifies that branch as an orphan and leaves it alone, and nothing ever
 * asks a second time, so every merged worktree on the machine survives forever.
 *
 * A claim is when the question can finally be answered: the previous round's merges
 * have landed by then. Sweeping HERE rather than fixing the close also covers the two
 * other ways a tree outlives its issue, without touching the close path at all —
 * because this re-derives status from the server on every run instead of judging once:
 *
 *  - a close from the Dash, another machine, or a proxy that restarted, which the
 *    on-close gate deliberately ignores (it only reaps leases IT saw taken), and
 *  - an issue whose agent ended at `review`, where no terminal close happens here at
 *    all and the later `done` comes from the reviewer's session, on their machine.
 *
 * The on-close reap keeps its ownership check, which is right for a scoped teardown of
 * one issue. This is the unscoped counterpart, and ownership is irrelevant to it: it
 * reaps on merged-and-closed, which is a fact about the branch, not about who held it.
 */
function sweepWorktrees(): void {
  if (!MAIN_CHECKOUT) return; // not in a git repo — nothing local to sweep
  if (swept) return; // once per session
  swept = true;
  // Same chain as the reaps: concurrent `tidy` children contend on `.git` locks.
  reapChain = reapChain.then(() => runSweep());
}

/** Run one `tidy` child to completion (resolve on exit/error/timeout). Never rejects —
 *  a failed teardown is best-effort cleanup, logged, never fatal. */
function runTidy(args: string[], label: string, timeoutMs: number, onSettle: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "tidy", ...args], {
      cwd: MAIN_CHECKOUT!,
      env: process.env,
      // stdout is ignored (tidy reports on stderr); stderr inherits so its log lands in
      // the same MCP stderr stream as the rest of the watchdog's output.
      stdio: ["ignore", "ignore", "inherit"],
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onSettle();
      resolve();
    };
    const timer = setTimeout(() => {
      log(`${label} timed out — killing it`);
      child.kill("SIGKILL"); // 'exit' still fires → finish() runs
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (e) => {
      log(`${label} couldn't start: ${String((e as any)?.message ?? e)}`);
      finish();
    });
    // Log a non-zero exit. `tidy` refuses to guess when it can't work out the repo's
    // trunk (RTSC-799), and a teardown that fails every time must not look exactly like
    // one that worked — the whole bug was a teardown failing in silence.
    child.on("exit", (code) => {
      if (code) log(`${label} exited ${code} — see its output above`);
      finish();
    });
    child.unref?.(); // a pending teardown must not keep the proxy alive
  });
}

function runReap(issueId: string): Promise<void> {
  log(`${issueId} closed → reaping its branch/worktree…`);
  return runTidy(["--prune", "--only", issueId], `reap of ${issueId}`, REAP_TIMEOUT_MS, () =>
    reaping.delete(issueId),
  );
}

function runSweep(): Promise<void> {
  log("first claim of this session → sweeping merged worktrees…");
  return runTidy(["--prune", "--auto"], "worktree sweep", SWEEP_TIMEOUT_MS, () => {});
}

/**
 * The auth header, or NOTHING when this proxy has no key (RTSC-879).
 *
 * `Bearer ` with an empty value is not a weaker credential, it is a malformed one: the
 * request is worse off for carrying it than for leaving it out. What made that matter is
 * where a keyless proxy now runs. In a Claude Code cloud container there is no keystore
 * and no `RETASC_MCP_KEY`, and the documented way to give that container a credential is
 * an environment API credential, which Anthropic's egress proxy INJECTS as an
 * `Authorization` header after the request leaves the VM — and which also lets the
 * request through a network allowlist that would otherwise refuse the host outright.
 *
 * Injection wants an absent header. Whether that proxy overwrites one already present is
 * not documented, so sending an empty Bearer bets the whole path on undocumented
 * behaviour. Omitting it needs no such bet.
 *
 * Nothing else changes: with a key this returns exactly what these call sites sent
 * before, and a keyless request still fails at Retasc the way it always did — it just
 * fails honestly, as unauthenticated, rather than as a credential that is present and
 * blank.
 */
function authHeader(): Record<string, string> {
  return activeKey ? { Authorization: `Bearer ${activeKey}` } : {};
}

async function postRemote(body: unknown): Promise<unknown> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      ...authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Auto-adopt a per-session key (RTSC-50). Mint one bound to our identity and use
 * it for the rest of the session, so concurrent sessions of the same agent are
 * distinguishable. Fail-soft: if minting is unavailable (older server, error),
 * keep using the workspace key — no worse than before — but LOUDLY (RTSC-143),
 * because on the shared key the per-session claim fence is inert.
 */
async function adoptSessionKey(parent: string = KEY): Promise<void> {
  if (!parent) return;
  const label = process.env.RETASC_SESSION_LABEL || `${hostname()}#${process.pid}`;
  // RTSC-861 — report our own version at the one call every proxy makes at startup,
  // so the server never has to infer whether this build is current. A proxy too old to
  // send it is exactly the case the server-side inference exists for.
  const outcome = await mintSessionKey({
    url: MCP_URL,
    key: parent,
    label,
    cliVersion: VERSION,
    autoUpdate: autoUpdateReport(),
    warn: log,
  });
  if (outcome.ok) {
    activeKey = outcome.key; // switch to the session key
    sessionParent = parent;
    log(`adopted session key "${outcome.session ?? label}"`);
  } else {
    sessionKeyFallback = true;
  }
}

/**
 * RTSC-1014 — adopt the credential for THIS TOOL, then mint the session key under it.
 *
 * The lineage this builds is `workspace key → harness key → session key`, and the middle
 * tier is what makes one tool retirable on its own: revoking it denies every session
 * beneath it through `resolveAuth`'s ancestry walk, and touches no sibling tool and not
 * the folder's binding.
 *
 * WHY IT RUNS HERE AND NOT AT STARTUP. The harness only names itself in the `initialize`
 * handshake, which arrives after `runProxy` has begun serving. `initialize` is also the
 * FIRST message any MCP client sends — before any `tools/call` — so deferring the session
 * mint to it keeps the promise the startup mint was written for: every claim is still
 * attributed to this session, because no claim can precede the handshake.
 *
 * THREE outcomes, and the middle one is the whole feature:
 *
 *  - a cached credential in the keystore → reuse it, no mint at all;
 *  - RETIRED → refuse. `sessionKeyBlocked` makes every forwarded call fail loudly. This
 *    must NEVER fall through to the workspace key: doing so would leave the retired tool
 *    running on the folder's shared credential, which is the retire silently undone —
 *    the one failure this issue exists to prevent;
 *  - anything else (old server, offline, a client nothing can name) → fall back to
 *    minting the session key off the workspace key, exactly as before this tier existed.
 */
async function adoptHarnessKey(reported: string): Promise<void> {
  if (!KEY || harnessAdopted) return;
  harnessAdopted = true;
  // A credential we already hold for this tool in this folder. It may be DEAD (a human
  // retired the tool since) — that is not checked here, because the session mint below is
  // the check: a revoked parent fails it, and the server then refuses to mint a
  // replacement, which is how a retire survives a restart.
  const cached = resolved.workspaceId
    ? getBinding(resolved.workspaceId)?.harnessKeys?.[reported]
    : undefined;
  if (cached) {
    const outcome = await mintSessionKeyOutcome(cached);
    if (outcome === "ok") return;
    if (outcome === "dead") {
      // The cached credential no longer authenticates. Ask for a fresh one: the server
      // says yes if the tool was merely rotated away, and refuses if it was retired.
      log(`the cached ${reported} credential no longer authenticates — asking for a new one`);
    }
  }
  const got = await mintHarnessKey({ url: MCP_URL, key: KEY, harness: reported, warn: log });
  if (got.ok) {
    if (resolved.workspaceId) {
      try {
        rememberHarnessKey(resolved.workspaceId, got.harness, got.key);
      } catch (e) {
        // A cache we could not write costs one extra mint next start, never correctness.
        log(`could not cache the ${got.harness} credential: ${String((e as any)?.message ?? e)}`);
      }
    }
    await adoptSessionKey(got.key);
    return;
  }
  if (got.retired) {
    harnessRetired = reported;
    log(`REFUSING TO SERVE: ${reported} was retired in this workspace.`);
    log(`Nothing here will run until a human re-binds this folder. The other tools in it are unaffected.`);
    return;
  }
  // Fail-soft, as before the harness tier existed.
  await adoptSessionKey(KEY);
}

/**
 * Mint the session key under `parent`, reporting whether the PARENT is the thing that
 * failed. `adoptSessionKey` cannot answer that — it is fail-soft by design — and a dead
 * cached harness credential has to be told apart from a network blip, because only the
 * first is worth asking the server for a replacement.
 */
async function mintSessionKeyOutcome(parent: string): Promise<"ok" | "dead"> {
  const label = process.env.RETASC_SESSION_LABEL || `${hostname()}#${process.pid}`;
  const outcome = await mintSessionKey({ url: MCP_URL, key: parent, label, cliVersion: VERSION, autoUpdate: autoUpdateReport(), warn: log });
  if (outcome.ok) {
    activeKey = outcome.key;
    sessionParent = parent;
    log(`adopted session key "${outcome.session ?? label}"`);
    return "ok";
  }
  // `dead` means "this parent did not work", and it deliberately does NOT try to separate
  // a revoked credential from a network blip. An earlier draft promised that distinction
  // and could not deliver it — `mintSessionKey` has already retried and collapses every
  // failure into `{ok:false}` — so the honest move is to name the outcome for what it is
  // and let the SERVER arbitrate: asking for a replacement returns a fresh credential if
  // the tool was merely rotated away, and refuses if it was retired. The cost of being
  // wrong is one extra harness key on a blip, not a tool that quietly keeps running.
  return "dead";
}

/**
 * RTSC-820 — tell the server which conversation this session is, once we know. Only on
 * a real session key: the workspace key is the folder, not a conversation, and the
 * server refuses it anyway. Looks for the Claude Code hook's record while nothing has
 * been found, a bounded number of times, then stops asking: a session whose harness
 * wired no hook simply never learns its id, and the Dash says so.
 */
/** RTSC-1057 — this machine's retention for the harness that wrote our transcript. */
let transcriptKeep: number | undefined;

async function reportTranscript(): Promise<void> {
  if (sessionKeyFallback || activeKey === KEY) return;
  // Once the id is recorded there is still one reason to come back: the model changed.
  // Grok reports no model at all, so a grok session stops here exactly as before.
  if (transcriptRecorded && (transcript?.harness === "grok" || !modelMayHaveChanged())) return;
  // Startup and the first forwarded call can both get here; one report at a time.
  if (transcriptInFlight) return transcriptInFlight;
  transcriptInFlight = reportTranscriptOnce().finally(() => { transcriptInFlight = null; });
  return transcriptInFlight;
}

/**
 * The record for this folder, but only if it is still describing OUR session (RTSC-821).
 *
 * The file is keyed by FOLDER alone, so a second session opened in the same directory
 * overwrites it with its own id and model. `at` cannot separate them here: a switch
 * deliberately leaves it untouched, so freshness says nothing on this path. The session
 * id is the only thing that does, and it is what the discovery path already matched on.
 */
function ownRecordModel(): string | undefined {
  if (!transcript) return undefined;
  // `maxAgeMs: Infinity` on purpose: a switch hours into a long conversation leaves `at`
  // where it was, so re-checking freshness would make exactly the case this exists for
  // invisible. The id check below is what makes dropping it safe.
  const rec = readHookRecord(process.cwd(), { maxAgeMs: Number.POSITIVE_INFINITY });
  if (!rec || rec.sessionId !== transcript.id) return undefined;
  // RTSC-832 — the TRANSCRIPT is the authority, and the only source that works at all
  // for a session nobody ran `/model` in: Claude Code 2.1.261 puts no `model` in the
  // SessionStart payload (captured 2026-09-05), so `rec.model` is set only by the
  // PostModelSwitch hook. The file has one on every assistant message, newest last,
  // so reading it covers the plain case AND a switch. `rec.model` stays as the fallback
  // for a harness that reports a model but writes no transcript we can read.
  // The switch hook is FRESHER than the file: right after `/model`, `rec.model` already
  // holds the new one while the newest assistant line still holds the old. Preferring
  // the file here delayed a switch to the next turn and lost it entirely if the session
  // ended first, which 1.42.0 got right. Once reported, this falls through and the file
  // is authoritative again (it also catches a switch that produced no hook at all).
  if (rec.model && rec.model !== reportedModel) return rec.model;
  if (rec.transcriptPath) {
    const fromFile = modelFromTranscript(rec.transcriptPath);
    if (fromFile) return fromFile;
  }
  return rec.model;
}

/**
 * Has the hook rewritten our record's model since we last reported one? (RTSC-821.)
 *
 * Throttled in TIME, not by the lookup budget: the budget is only spent when there is
 * something to report, so in the steady state (the model never changes) nothing would
 * ever increment it and every forwarded tool call would pay a realpath + hash + read +
 * parse on the response path. A switch is a human pressing keys; three seconds of
 * latency on noticing one is free, and a busy session makes hundreds of calls in that
 * window.
 */
function modelMayHaveChanged(): boolean {
  if (transcriptLookups >= TRANSCRIPT_LOOKUPS_MAX) return false;
  const now = Date.now();
  if (now - lastModelCheckAt < MODEL_CHECK_INTERVAL_MS) return false;
  lastModelCheckAt = now;
  // Cached for the reporter that runs next: this whole path is synchronous on the
  // response path, and scanning the transcript twice per change tick is pure waste.
  pendingModel = ownRecordModel();
  return !!pendingModel && pendingModel !== reportedModel;
}

async function reportTranscriptOnce(): Promise<void> {
  // One budget for looking AND for asking: a server that keeps refusing is not asked
  // on every call for the rest of the session either.
  if (transcriptLookups >= TRANSCRIPT_LOOKUPS_MAX) return;
  transcriptLookups += 1;
  if (transcriptRecorded) {
    // Recorded already, so we are here only for a model change — and only for OURS.
    // `modelMayHaveChanged` just did this scan; reuse it rather than paying it twice.
    const model = pendingModel ?? ownRecordModel();
    if (!model || model === reportedModel || !transcript) return;
    const switched = await recordSession({ url: MCP_URL, key: activeKey, transcriptId: transcript.id, harness: transcript.harness, model, warn: log });
    if (switched) {
      reportedModel = model;
      log(`session model is now ${model}`);
    }
    return;
  }
  if (!transcript) {
    const now = Date.now();
    if (now - PROXY_STARTED_AT > RECORD_SEARCH_MS) {
      transcriptLookups = TRANSCRIPT_LOOKUPS_MAX; // stop looking: any record now is the next session's
      return;
    }
    // A record written within a minute before we started, or up to a few minutes after:
    // the hook and the proxy are spawned together. Older belongs to an earlier session in
    // this folder; newer belongs to a later one.
    // RTSC-1084 — PI HAS NO RECORD TO FIND, because it has nothing to write one with:
    // no MCP client of its own, so no handshake, and `PI_SESSION_ID` does not exist in
    // the shipped build however clearly pi.dev documents it (measured on 0.74.2).
    //
    // So its transcript is derived from the FOLDER instead — the same meeting point the
    // hook record uses, reached from the other end. `PROXY_STARTED_AT` is the honesty
    // bound: the adapter spawns us lazily on the first tool call, so Pi's file already
    // exists and is OLDER than we are, and the window has to look backwards rather than
    // forwards. One minute is the same span the hook record allows in that direction.
    //
    // Only the ID is reported. The path is kept for the same local-only reason
    // `HookRecord.transcriptPath` is (RTSC-832): the proxy reads that machine's own file
    // and never sends it.
    if (isPiClient(clientName, envHarness)) {
      const pi = findPiTranscript(process.cwd(), { notBefore: PROXY_STARTED_AT - PI_LOOKBACK_MS });
      // Nothing readable: Pi keeps saying it has no transcript, which is the honest
      // answer and the one every unadapted harness gives.
      if (!pi) return;
      transcript = { id: pi.sessionId, harness: "pi" };
      transcriptKeep = transcriptKeepDays("pi", process.cwd());
      // FALLS THROUGH to the report below — it does NOT return. Setting `transcript`
      // only records the fact locally; `recordSession` at the end of this function is
      // what tells the server, and an early return here left every Pi session with a
      // transcript the proxy knew and the Dash never saw. Found by running it.
    } else {
    const rec = readHookRecord(process.cwd(), {
      now,
      maxAgeMs: now - PROXY_STARTED_AT + 60_000,
      notAfter: PROXY_STARTED_AT + RECORD_NOT_AFTER_MS,
    });
    if (!rec) return;
    // A record names its harness; the client named itself at `initialize`. Different
    // harness, not our record (a Codex pane opened in a folder a Claude hook wrote for).
    if (rec.harness === "claude-code" && clientName && !/claude/i.test(clientName)) return;
    // RTSC-1154 — the OpenCode plugin now reports every top-level session, so its records
    // are more frequent; one must never be adopted by another harness's proxy that happens
    // to start in the same folder inside the window.
    if (rec.harness === "opencode" && clientName && !/opencode/i.test(clientName)) return;
    // RTSC-832 — the transcript usually has no assistant message yet at this point, so
    // this is normally undefined and the model arrives on a later re-report. It matters
    // when the proxy comes up mid-session (a restart), where the file already has one.
    const startModel = (rec.transcriptPath ? modelFromTranscript(rec.transcriptPath) : undefined) ?? rec.model;
    transcript = { id: rec.sessionId, harness: rec.harness, model: startModel, agentType: rec.agentType, agentId: rec.agentId };
    // RTSC-1057 — read ONCE, here, with the record that named the harness. It is a
    // settings file on this machine, so it cannot change meaningfully inside one session,
    // and the re-report path below is for a model switch.
    transcriptKeep = transcriptKeepDays(rec.harness, process.cwd());
    }
  }
  const ok = await recordSession({
    url: MCP_URL,
    key: activeKey,
    transcriptId: transcript.id,
    harness: transcript.harness,
    model: transcript.model,
    agentType: transcript.agentType,
    agentId: transcript.agentId,
    transcriptKeepDays: transcriptKeep,
    warn: log,
  });
  if (ok) {
    transcriptRecorded = true;
    reportedModel = transcript.model;
    // RTSC-821 — claude-code's record is NOT consumed any more, whether or not it came
    // with a model. Clearing it made `retasc hook model-switch` a permanent no-op for
    // that folder (`updateHookRecordModel` returns early when the file is gone), and the
    // session most in need of the switch hook is precisely the one whose SessionStart
    // payload carried NO model — which Claude Code omits after a /clear and on recovery.
    //
    // Nothing adopts it in the meantime: the discovery path still checks `notAfter` and
    // `maxAge`, and every re-read goes through `ownRecordModel`, which matches the
    // session id. The next SessionStart in this folder overwrites the file, so it never
    // accumulates, and an abandoned one is collected by the 24h sweep.
    if (transcript.harness !== "grok" && transcript.harness !== "claude-code") clearHookRecord(process.cwd());
    log(`session recorded as ${transcript.harness} transcript ${transcript.id}${transcript.model ? ` on ${transcript.model}` : ""}`);
  }
}

/**
 * RTSC-91 (DESIGN §13, D2): announce the binding to the HUMAN on startup, so the
 * org/project this session will write into is visible in the harness's MCP logs
 * before any work. Best-effort — never blocks serving traffic.
 */
async function announceBinding(): Promise<void> {
  try {
    const resp = await postRemote({
      jsonrpc: "2.0",
      id: RPC_ID.announce,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    const r = toolResult(resp, "whoami") as any;
    if (r?.org && r?.project) {
      log(`bound → org "${r.org.name}" / project ${r.project.prefix}`);
    }
  } catch {
    /* announcement is best-effort */
  }
}

// The tool result payload — shared tolerant parser (RTSC-143), warning through
// our stderr logger (tool-labeled, so a busy MCP log names which call degraded)
// when it had to recover a JSON prefix or fall back raw.
function toolResult(resp: unknown, tool?: string): unknown {
  return parseTool(resp, (msg) => log(tool ? `${tool}: ${msg}` : msg));
}

/** Write one JSON-RPC tool result back to the harness (the local half of a tools/call). */
function replyToolResult(id: unknown, text: string, isError: boolean): void {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
    }) + "\n",
  );
}

/**
 * Serve `save_attachment_file` LOCALLY (RTSC-660): the agent names a path, we read the bytes
 * and POST them with the key we already hold. This is the whole fix — it turns the one write
 * an agent could not complete on its own into a single tool call, and removes the step where
 * a well-behaved agent had to go reading a credential file off disk.
 *
 * The upload URL is fetched from the server rather than composed here, so the issue check,
 * the project boundary and the endpoint's shape all stay server-authoritative and this side
 * holds no policy it could get wrong. The path is validated first, before we spend a round
 * trip on a file we would refuse to read anyway.
 *
 * Every accepted read is logged to stderr with its resolved path: a proxy-side read bypasses
 * the harness's own file-access prompt, so the MCP log is where a human can see what was
 * actually opened on their behalf.
 */
async function handleLocalAttach(msg: any): Promise<void> {
  const args = (msg.params?.arguments ?? {}) as { issue?: unknown; path?: unknown; title?: unknown };
  const issue = typeof args.issue === "string" ? args.issue.trim() : "";
  if (!issue) return replyToolResult(msg.id, "issue is required (e.g. RTSC-12)", true);

  const resolved = resolveAttachPath(String(args.path ?? ""), ATTACH_ROOT);
  if (!resolved.ok) {
    log(`refused attachment for ${issue}: ${resolved.error}`);
    return replyToolResult(msg.id, resolved.error, true);
  }

  // Ask the server where this issue's bytes go. Doubles as the auth + issue-exists check, so
  // a bad id or a foreign project fails before we open anything.
  let prepared: any;
  try {
    prepared = toolResult(
      await postRemote({
        jsonrpc: "2.0",
        id: hbSeq--,
        method: "tools/call",
        params: { name: "prepare_attachment_upload", arguments: { issue } },
      }),
      "prepare_attachment_upload",
    );
  } catch (e) {
    return replyToolResult(msg.id, `could not reach Retasc: ${String((e as any)?.message ?? e)}`, true);
  }
  const uploadUrl = typeof prepared?.uploadUrl === "string" ? prepared.uploadUrl : "";
  if (!uploadUrl) {
    // Relay what the server said rather than a generic failure: it is usually NOT_FOUND for
    // this issue, and that is the sentence the agent needs to see.
    const detail = typeof prepared === "string" ? prepared : JSON.stringify(prepared ?? null);
    return replyToolResult(msg.id, `could not prepare an upload for ${issue}: ${detail}`, true);
  }

  const title = typeof args.title === "string" ? args.title : undefined;

  // Open AFTER the round trip, and re-prove the inode: the path was resolved before we went to
  // the network, and reading it by path again here would follow whatever it points at now
  // (RTSC-801). `readAttachFile` opens O_NOFOLLOW and reads from the descriptor.
  const read = readAttachFile(resolved);
  if (!read.ok) {
    log(`refused attachment for ${issue}: ${read.error}`);
    return replyToolResult(msg.id, read.error, true);
  }
  const bytes = read.bytes;

  log(`attaching ${resolved.path} (${bytes.length} bytes) to ${issue}`);
  try {
    const res = await fetch(uploadUrlWith(uploadUrl, resolved.filename, title), {
      method: "POST",
      // No Content-Type on purpose: the server infers it from `filename`, and that inference
      // is better than anything guessed here — declaring octet-stream would REPLACE it and
      // cost the attachment its inline preview.
      headers: authHeader(),
      body: bytes,
    });
    const body = await res.text();
    if (!res.ok) {
      log(`upload of ${resolved.filename} to ${issue} failed: HTTP ${res.status}`);
      return replyToolResult(msg.id, uploadFailureMessage(res.status, body), true);
    }
    return replyToolResult(msg.id, body, false);
  } catch (e) {
    return replyToolResult(msg.id, `upload failed: ${String((e as any)?.message ?? e)}`, true);
  }
}

/**
 * Serve `get_attachment_file` LOCALLY (RTSC-681): the agent names an attachment id, we fetch
 * the bytes with the key we already hold and write them to a file the agent can open. The
 * mirror of handleLocalAttach above, and the other half of the same fix — attachments were a
 * one-way street, and the way back required a credential the model is told it must not go
 * looking for.
 *
 * The metadata comes from the server rather than being assumed here, for the same reason the
 * upload asks for its URL: the auth check, the project boundary and "is there even a file"
 * stay server-authoritative, so this side holds no policy it could get wrong. Only then do we
 * spend a download.
 *
 * Every write is logged to stderr with its resolved path. A proxy-side write bypasses the
 * harness's own file-write prompt, so the MCP log is where a human can see what appeared on
 * their disk on their behalf.
 */
async function handleLocalFetch(msg: any): Promise<void> {
  const args = (msg.params?.arguments ?? {}) as { attachment?: unknown };
  const attachment = typeof args.attachment === "string" ? args.attachment.trim() : "";
  if (!attachment) {
    return replyToolResult(msg.id, "attachment is required (an attachment id from list_attachments)", true);
  }

  // Ask the server what this is. Doubles as the auth + existence + project-boundary check, so
  // a bad id or a foreign project fails before we write anything.
  let meta: any;
  try {
    meta = toolResult(
      await postRemote({
        jsonrpc: "2.0",
        id: hbSeq--,
        method: "tools/call",
        params: { name: "get_attachment", arguments: { attachment } },
      }),
      "get_attachment",
    );
  } catch (e) {
    return replyToolResult(msg.id, `could not reach Retasc: ${String((e as any)?.message ?? e)}`, true);
  }
  const url = typeof meta?.url === "string" ? meta.url : "";
  if (!url) {
    // Relay what the server said rather than a generic failure: it is usually NOT_FOUND for
    // this id, and that is the sentence the agent needs to see.
    const detail = typeof meta === "string" ? meta : JSON.stringify(meta ?? null);
    return replyToolResult(msg.id, `could not read attachment ${attachment}: ${detail}`, true);
  }
  // Whether there are bytes is the SERVER's answer, never inferred from the URL. An earlier
  // draft fell back to matching the download path in the URL when `hasFile` was absent, which
  // is a credential leak: a LINK attachment's URL is arbitrary text any org member can write,
  // so `https://evil.example/attachments/download?x=1` would have matched and this fetch would
  // have carried our Bearer token to their host. A server too old to answer gets an error that
  // names the fix, which is the safe direction to fail.
  if (meta.hasFile !== true) {
    const why =
      meta.hasFile === false
        ? `attachment ${attachment} is a link, not an uploaded file — there are no bytes to download. ` +
          `Fetch it yourself if you can reach it: ${url}`
        : `this Retasc deployment is too old to serve get_attachment_file (its get_attachment does ` +
          `not report whether an attachment has a file). Ask your human to update the backend.`;
    return replyToolResult(msg.id, why, true);
  }
  // Belt and braces on the URL the server handed back: only ever send the credential to the
  // endpoint this feature is about, over http(s), never to a `file:`/`data:` scheme or some
  // other path that a future server-side bug might emit here.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return replyToolResult(msg.id, `could not read attachment ${attachment}: the server returned an unusable URL`, true);
  }
  // `endsWith`, not `===`: a deployment whose site URL carries a path prefix serves the same
  // endpoint under it, and rejecting that would break a legitimate install to catch nothing.
  if (!/^https?:$/.test(parsed.protocol) || !parsed.pathname.endsWith("/attachments/download")) {
    log(`refused download of ${attachment}: unexpected download URL ${parsed.origin}${parsed.pathname}`);
    return replyToolResult(
      msg.id,
      `refusing to download ${attachment}: the server returned an unexpected download URL.`,
      true,
    );
  }
  const declared = typeof meta.bytes === "number" ? meta.bytes : undefined;
  if (declared !== undefined && declared > MAX_FETCH_BYTES) {
    return replyToolResult(msg.id, `attachment ${attachment} is ${declared} bytes, over the ${MAX_FETCH_BYTES}-byte limit`, true);
  }

  const target = resolveDownloadTarget(ATTACH_ROOT, attachment, meta.filename ?? meta.title);
  if (!target.ok) {
    log(`refused download of ${attachment}: ${target.error}`);
    return replyToolResult(msg.id, target.error, true);
  }

  const describe = (bytes: number, cached: boolean) =>
    JSON.stringify(
      {
        attachment,
        issue: meta.issue,
        path: target.path,
        filename: target.filename,
        bytes,
        contentType: meta.contentType,
        obsolete: meta.obsolete ?? false,
        cached,
        note: "The file is on disk — read it with your normal file tools. Copy it elsewhere yourself if you want to keep it; this directory is git-ignored and is not cleaned up for you.",
      },
      null,
      2,
    );

  // RTSC-806: every directory between the workspace and the file must be a real one, checked
  // before the cache lookup too, so a "cached" file is never one sitting behind a planted link.
  const dir = prepareDownloadDir(target, ATTACH_ROOT);
  if (!dir.ok) {
    log(`refused download of ${attachment}: ${dir.error}`);
    return replyToolResult(msg.id, dir.error, true);
  }

  // An attachment id maps to immutable bytes, so a file already sitting at this exact path IS
  // this attachment — hand it back rather than paying for the same egress twice.
  const existing = existingDownload(target.path);
  if (existing && "symlink" in existing) {
    const error = `refusing to use ${target.path}: it is a symlink, not a downloaded file. Remove it and try again.`;
    log(error);
    return replyToolResult(msg.id, error, true);
  }
  if (existing) {
    log(`${attachment} already downloaded → ${target.path}`);
    return replyToolResult(msg.id, describe(existing.size, true), false);
  }

  try {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      const body = await res.text();
      log(`download of ${attachment} failed: HTTP ${res.status}`);
      return replyToolResult(msg.id, downloadFailureMessage(res.status, body), true);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The declared size was a claim; this is what actually arrived. Check it before it lands
    // on disk — a response is not bounded by what the metadata said it would be.
    if (bytes.byteLength > MAX_FETCH_BYTES) {
      return replyToolResult(msg.id, `download aborted: ${bytes.byteLength} bytes exceeds the ${MAX_FETCH_BYTES}-byte limit`, true);
    }
    writeDownloadedFile(target, bytes, ATTACH_ROOT);
    log(`downloaded ${attachment} (${bytes.byteLength} bytes) → ${target.path}`);
    return replyToolResult(msg.id, describe(bytes.byteLength, false), false);
  } catch (e) {
    return replyToolResult(msg.id, `download failed: ${String((e as any)?.message ?? e)}`, true);
  }
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // not a JSON-RPC message — ignore
  }

  // RTSC-660: a file attachment by PATH is served here, not forwarded — the bytes are on
  // THIS machine and the credential is in this process. Anything else (including the same
  // tool called with `contentBase64`, the server's own variant) goes remote untouched.
  if (isLocalAttachCall(msg)) return await handleLocalAttach(msg);

  // RTSC-681: the read counterpart. Whenever a proxy is present, downloading to disk beats
  // the server's inline variant on every axis (no size ceiling, no bytes in the model's
  // context), so every call to the tool is served here rather than forwarded.
  if (isLocalFetchCall(msg)) return await handleLocalFetch(msg);

  // RTSC-780: an unbound folder answers every tool call itself. `initialize` and
  // `tools/list` still go remote, so the agent starts cleanly and can SEE the tools —
  // the failure has to arrive at the moment one is used, worded as the folder problem
  // it is, rather than as a startup crash the harness reports as "server unreachable".
  if (UNBOUND && msg.method === "tools/call" && msg.id !== undefined) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: UNBOUND_MESSAGE }], isError: true },
      }) + "\n",
    );
    return;
  }

  if (msg.method === "initialize") {
    const n = msg.params?.clientInfo?.name;
    if (typeof n === "string" && n) clientName = n;
    // RTSC-1080 — the ENVIRONMENT outranks the handshake for harnesses we recognise
    // there. `clientInfo.name` is whatever a client chose to call itself; `AI_AGENT` is
    // set by the harness in the environment we were spawned into.
    if (envHarness) clientName = envHarness;
    // RTSC-1014 — the handshake is the first moment this tool has a name, so it is where
    // its credential is adopted and the session key minted under it. AWAITED: the
    // `initialize` response must not go out before the session is on the key its claims
    // will be attributed to, and a client is entitled to call a tool the instant it
    // returns. The server resolves the reported name (`sessionRuntime`), so the raw
    // string goes over as-is and the CLI keeps no copy of the alias table.
    if (clientName) await adoptHarnessKey(clientName);
    // RTSC-1155 — on the session key just minted, and off the handshake's path: take over
    // what a restarted proxy in this window left behind, and note which conversation the
    // window is on now.
    adoptOrphanedClaims().catch((e) => log(`take-over: ${String((e as any)?.message ?? e)}`));
    // RTSC-1154 — Pi's MCP adapter closes an idle server after 10 minutes by default,
    // which kills this watchdog and every lease it renews. Make sure Pi keeps us alive
    // from now on. After the response, and best effort: it only edits Pi's own file.
    if (isPiClient(clientName, envHarness)) {
      setTimeout(() => {
        try {
          // Resolved only if a write is needed: it runs processes, and the common case is
          // an entry that is already right.
          const r = ensurePiKeepAlive(() =>
            autoMarkerEntry(
              onDurablePath("retasc")
                ? { command: "retasc", args: [] as string[] }
                : { command: "npx", args: ["-y", "@retasc/cli@latest"] },
            ),
          );
          if (r === "written") log("Pi: kept the retasc server alive, so an idle Pi no longer stops this watchdog");
        } catch {
          /* best effort */
        }
      }, 1000).unref?.();
    }
    // RTSC-820, moved here with the mint it depends on: the transcript report needs a
    // real session key (it is refused on the workspace key), and one now exists only
    // after the handshake. Fire-and-forget, as it was at startup — a session that has
    // not found its hook record yet retries on forwarded calls.
    reportTranscript().catch((e) => log(`record_session: ${String((e as any)?.message ?? e)}`));
  }

  // RTSC-1014 — a client that talks WITHOUT handshaking still gets a session key, off the
  // workspace key, exactly as every client did before this tier existed. The MCP spec
  // says `initialize` comes first and real harnesses obey it, but diagnostics and older
  // clients do not, and losing the per-session claim fence (RTSC-50) for them would be a
  // silent regression bought for nothing: with no `clientInfo` there is no harness to
  // name, so there is no harness credential to hang them off either.
  if (!harnessAdopted && msg.method !== "initialize") {
    // RTSC-1080 — unless the ENVIRONMENT named the harness. A client that never
    // handshakes used to be unattributable by construction; when `AI_AGENT` names one
    // we know, it is attributable after all, and hanging it off its own credential is
    // what keeps its work off another tool's name.
    if (envHarness) {
      clientName = envHarness;
      await adoptHarnessKey(envHarness);
    } else {
      harnessAdopted = true;
      await adoptSessionKey(KEY);
    }
    reportTranscript().catch((e) => log(`record_session: ${String((e as any)?.message ?? e)}`));
  }

  // RTSC-1014 — a retired tool is served NOTHING, and is told why rather than failing
  // with an auth error it cannot act on. This is deliberately not a fall back to the
  // workspace key: that would leave the tool running on the folder's shared credential
  // and undo the retire a human asked for.
  if (harnessRetired && msg.method !== "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: {
          code: -32000,
          message:
            `retasc: ${harnessRetired} was retired in this workspace, so it is not serving here. ` +
            `Its siblings in this folder are unaffected. Re-bind the folder to bring it back.`,
        },
      }) + "\n",
    );
    return;
  }

  let resp: unknown;
  try {
    const sentWith = activeKey;
    resp = await postRemote(msg);
    // RTSC-1194 — a session key the server expired under a live session is replaced and the
    // call retried ONCE; so is a call that left on a key a concurrent heal has since
    // replaced. The agent sees its answer, not an auth error it cannot act on. The raw
    // envelope, not `toolResult`: an error's text is not JSON, and parsing it here would log
    // a "fell back to raw" warning a second time for every refused call.
    const envelope = (resp as { result?: unknown } | null)?.result;
    if (
      msg.method === "tools/call" &&
      (expiredAndStale(envelope, sentWith) || (isSessionKeyExpired(envelope) && (await healSessionKey())))
    ) {
      resp = await postRemote(msg);
    }
  } catch (e) {
    // Forwarding failed: return a JSON-RPC error so the harness doesn't hang.
    if (msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `retasc proxy forward failed: ${String((e as any)?.message ?? e)}` },
        }) + "\n",
      );
    }
    return;
  }

  // RTSC-660: advertise the PATH form of save_attachment_file in place of the server's
  // base64 one. A tool list is fetched once at startup, so this is the only moment we get to
  // tell the agent which shape this environment can actually serve.
  if (msg.method === "tools/list" && resp && typeof resp === "object") {
    const result = (resp as { result?: { tools?: unknown } }).result;
    if (result && Array.isArray(result.tools)) {
      result.tools = mergeAttachTool(result.tools, ATTACH_ROOT);
      // RTSC-681: same override for the read half — one name, the shape this environment can
      // actually serve, decided at the only moment we get to tell the agent (tools/list is
      // fetched once, at startup).
      result.tools = mergeFetchTool(result.tools, ATTACH_ROOT);
    }
  }

  // Watch tools/call traffic for claims/releases (request args + result), and
  // flag the workspace-key fallback on whoami so the AGENT sees the degraded
  // state (RTSC-143) — the startup stderr warning only reaches the MCP logs.
  let reapId: string | undefined;
  let claimed = false;
  if (msg.method === "tools/call") {
    reportTranscript().catch((e) => log(`record_session: ${String((e as any)?.message ?? e)}`));
  }
  if (msg.method === "tools/call" && resp) {
    const result = toolResult(resp, msg.params?.name);
    const obs = { toolName: msg.params?.name, args: msg.params?.arguments, result };
    // Decide the reap BEFORE applyObservation drops the lease (the gate checks lease
    // ownership). Pure decision — see shouldReapOnClose. We act on it AFTER relaying
    // the response, below (RTSC-181).
    reapId = shouldReapOnClose(obs, leases);
    // RTSC-1042 — a successful claim is the sweep's trigger. Decided here with the
    // rest of the observation, acted on after the response is relayed (below).
    claimed = isClaimObservation(obs);
    // RTSC-646: warn BEFORE applyObservation, while the map still reflects what we
    // were renewing when the call was made — after it, a fresh claim would look
    // tracked and a deliberate release would look untracked.
    const warning = untrackedLeaseWarning(obs, leases);
    if (warning) log(`warning: ${warning}`);
    const before = new Map(leases);
    applyObservation(leases, obs);
    // RTSC-1150 — a lease this call took (or re-took) is confirmed until the expiry the
    // server named. The file itself is written after the response is relayed (below).
    noteClaimed(before, result);
    appendFallbackNotice(msg.params?.name, resp, sessionKeyFallback);
    // RTSC-962 — attach what the LAST scan found, then start the next one WITHOUT
    // awaiting it.
    //
    // The order matters and it is the same rule RTSC-181 states for the reap: git must
    // never delay the response the agent is blocked on. Awaiting the scan would put two
    // `git` invocations per worktree AND a full network round-trip on the critical path
    // of one tool call in every thirty seconds — hundreds of milliseconds on a large
    // repo, paid by the agent, forever. So the notice is attached from the previous
    // scan's result and the fresh scan runs in the background.
    //
    // The cost of that is one call of latency on FIRST detection — a few seconds — and
    // it buys a proxy that is never in the way. A hold lasts an hour; being told about
    // it one call later changes nothing.
    //
    // `scanWorktrees` is started after `applyObservation` so a claim made by this very
    // call is already in `leases` and its own worktree is not reported as unclaimed.
    appendUnclaimedNotice(resp);
    // RTSC-1155 — a conversation change under this proxy, or claims it took over.
    checkConversationChange(before);
    attachPendingNotice(resp);
    // RTSC-1153 — "Retasc now updates itself", once per machine, on the first successful
    // tool result any session on it relays. One attempt per proxy: after that the answer
    // is settled for this process, so the config is not read on every call.
    if (!autoUpdateNoticeTried && (resp as any)?.result && !(resp as any).result.isError) {
      autoUpdateNoticeTried = true;
      attachAutoUpdateNotice(resp, () => takeAutoUpdateNotice(process.env));
    }
    void scanWorktrees().catch((e) => log(`worktree scan: ${String((e as any)?.message ?? e)}`));
  }

  // Relay the response (requests have an id; notifications don't).
  if (resp != null && msg.id !== undefined) {
    process.stdout.write(JSON.stringify(resp) + "\n");
  }

  // RTSC-1150 — the window's next conversation reads what we hold from this file. After
  // the relay, like the reap: the first write may run `ps`, and that must not delay the
  // response the agent is waiting on.
  if (msg.method === "tools/call" && resp) syncLeaseFile(false);

  // Reap only after the tool result is on the wire — spawns its own process, so git
  // never delays the response the agent is blocked on (RTSC-181). The sweep is held to
  // the same rule for the same reason (RTSC-1042): an agent waiting on a claim must
  // never wait on this machine's housekeeping.
  if (reapId) reapClosedIssue(reapId);
  if (claimed) sweepWorktrees();
}

/**
 * RTSC-962 — look for unclaimed `rtsc-NN/<slug>` worktrees on this machine and report
 * them, so the server can record a provisional hold.
 *
 * Every decision here is in `lib/worktreeReport.ts` and unit-tested; this function is
 * only the git I/O and the network call. It is a NO-OP outside a git repo, and it never
 * throws: a census that fails must not fail — or even alter — the agent's tool call.
 *
 * Report-only. It never claims (client-side lease bookkeeping would lock the real worker
 * out of `checkpoint`/`done`), never blocks, and never rewrites the request.
 */
async function scanWorktrees(): Promise<void> {
  if (!MAIN_CHECKOUT) return; // not in a git repo — nothing local to see
  if (scanning) return; // a scan is already in flight — never pile them up
  const now = Date.now();
  if (now - lastWorktreeScan < WORKTREE_SCAN_MS) return;
  lastWorktreeScan = now;
  scanning = true;
  try {
    await runScan(now);
  } finally {
    scanning = false;
  }
}

async function runScan(now: number): Promise<void> {
  const list = await git(["worktree", "list", "--porcelain"], MAIN_CHECKOUT!);
  if (list === null) return;
  const trees = candidateTrees(list);
  if (trees.length === 0) {
    activeHolds = new Map();
    return;
  }

  // One `status` + one `log` per candidate. Bounded by the number of agent worktrees on
  // the machine (a handful), and only for branches that already match the convention —
  // never a walk of the repo.
  const state = new Map<string, TreeState>();
  for (const t of trees) {
    const st = await git(["status", "--porcelain"], t.path);
    if (st === null) continue; // the tree is gone or unreadable — say nothing
    const log = await git(["log", "-1", "--format=%ct"], t.path);
    const secs = log === null ? NaN : Number(log.trim());
    state.set(t.path, {
      dirty: st.trim().length > 0,
      ...(Number.isFinite(secs) && secs > 0 ? { lastCommitAt: secs * 1000 } : {}),
    });
  }

  const worktrees = buildReport({ trees, state, held: leases.keys(), now });
  if (worktrees.length === 0) {
    activeHolds = new Map();
    return;
  }

  try {
    const result = toolResult(await postRemote(reportRequest(hbSeq--, worktrees)), "report_worktrees");
    const holds = holdsFrom(result);
    // Rebuilt from THIS scan, never merged into the last one: an issue that dropped off
    // the server's list was claimed, closed, or lapsed, and must stop being announced.
    const byIssue = new Map(worktrees.map((w) => [w.identifier, w.branch]));
    activeHolds = new Map(holds.map((id) => [id, byIssue.get(id) ?? id]));
  } catch (e) {
    // An older deployment has no such tool, and a network blip is a network blip.
    // Either way the agent's call is unaffected — that is the whole contract.
    log(`report_worktrees: ${String((e as any)?.message ?? e)}`);
  }
}

/**
 * RTSC-962 — attach the ⚑ line to the response the agent is about to read, in its OWN
 * content block.
 *
 * Same mechanics and the same reason as `appendFallbackNotice`: content[0].text must
 * stay machine-parseable JSON (RTSC-142), and anything unexpected about the shape leaves
 * the response untouched — a malformed notice must never break the protocol stream it
 * rides on. Silent on an error response: an agent reading a refusal has a more urgent
 * problem than an unclaimed worktree.
 */
function appendUnclaimedNotice(resp: unknown): void {
  // Prunes holds that have gone AND returns only the ones not yet announced. Run
  // unconditionally (not behind an `activeHolds.size` guard) so the pruning happens even
  // when the last scan came back empty — otherwise a hold that lapsed and was later seen
  // again would stay marked as announced and never be mentioned a second time.
  const fresh = holdsToAnnounce(activeHolds, announcedHolds, leases.keys());
  if (fresh.length === 0) return;
  const result = (resp as any)?.result;
  if (result?.isError) return;
  if (!Array.isArray(result?.content)) return;
  const text = unclaimedNotice(fresh, activeHolds);
  if (!text) return;
  result.content.push({ type: "text", text });
  // Marked only once the line is actually ON the response — an early return above must
  // not burn the one announcement this hold gets.
  for (const id of fresh) announcedHolds.add(id);
}

/**
 * RTSC-1150 — the Claude Code process we run under: the nearest ancestor its SessionStart
 * hook has written a record for (lib/sessionHook.ts). A sibling window is never our
 * ancestor, and a nested Claude Code is nearer than the one it runs inside. Once found it
 * is kept (the record may be swept later), but the ancestors NEARER than it are looked at
 * again every time: the hook and we start in either order, and a nested Claude Code whose
 * record lands late must still win over the outer window it runs in.
 *
 * Claude Code only, decided by the handshake. A Codex or Pi proxy started from a Claude
 * Code shell has that Claude Code among its ancestors, and must not list its claims as
 * that window's.
 */
/** RTSC-1155 — which server and credential this proxy's claim tokens belong to, as the
 *  lease file records it: a short hash, never the key itself. */
const BINDING_ID = createHash("sha256").update(`${MCP_URL}\n${KEY ?? ""}`).digest("hex").slice(0, 16);

/** RTSC-1155 — the window of a harness other than Claude Code, found from the process
 *  tree (lib/conversation.ts `findWindowPid`); undefined until first looked up. */
let windowPid: number | null | undefined;

let windowLookup: Promise<number | null> | null = null;
let windowLookupFailedAt = 0;

/** RTSC-1155 — resolve this proxy's window once, OFF the request path: `ps` is a process
 *  spawn, and a synchronous one here would stall every tool call it ran on. A failure
 *  (ps missing, a timeout under load) is retried at most once a minute. */
function resolveWindow(): Promise<number | null> {
  if (windowPid !== undefined) return Promise.resolve(windowPid);
  if (windowLookup) return windowLookup;
  if (Date.now() - windowLookupFailedAt < 60_000) return Promise.resolve(null);
  windowLookup = new Promise((done) => {
    let out = "";
    let settled = false;
    const finish = (w: number | null | undefined) => {
      if (settled) return;
      settled = true;
      windowLookup = null;
      if (w === undefined) {
        windowLookupFailedAt = Date.now();
        done(null);
        return;
      }
      // A Claude Code window (its hook left a record under this pid) is never another
      // harness's to speak for: its hook would tell ITS conversation about our claims.
      windowPid = w !== null && readHarnessRecord(w) ? null : w;
      done(windowPid);
    };
    try {
      const p = spawn("ps", ["-A", "-o", "pid=,ppid=,args="], { stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => {
        p.kill();
        finish(undefined);
      }, 5_000);
      timer.unref?.();
      p.stdout.on("data", (d) => (out += d.toString()));
      p.on("error", () => finish(undefined));
      p.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? findWindowPid(out, process.ppid) : undefined);
      });
    } catch {
      finish(undefined);
    }
  });
  return windowLookup;
}

function harnessPid(): number | null {
  if (!clientName) return null;
  if (!/claude/i.test(clientName)) {
    if (windowPid === undefined) void resolveWindow();
    return windowPid ?? null;
  }
  if (ancestors === null) {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
    if (r.status !== 0) {
      // Not cached: a timeout under load is worth another try at the next sync.
      if (!psWarned) {
        psWarned = true;
        log(
          `could not read the process table (ps: ${r.error?.message ?? `exit ${r.status}`}), so a /clear in ` +
            `this window will not be told which claims it still holds. Renewal is unaffected.`,
        );
      }
      return harness;
    }
    ancestors = parseAncestry(r.stdout ?? "", process.ppid);
  }
  for (const pid of ancestors) {
    if (pid === harness) break;
    if (readHarnessRecord(pid)) return (harness = pid);
  }
  return harness;
}

/** RTSC-1150 — a claim response names when the lease runs until; trust that over a guess. */
function expiryOf(obj: unknown, now: number): number {
  const at = obj && typeof obj === "object" ? (obj as { claimExpiresAt?: unknown }).claimExpiresAt : undefined;
  return typeof at === "number" && at > now ? at : now + LEASE_TTL_MS;
}

/**
 * RTSC-1155 — the held-claims notice waiting for the next successful Retasc tool result:
 * the channel every harness shows its agent. Set when this proxy took over a restarted
 * window's claims, or when the window's conversation changed under it.
 */
let pendingNotice: string | null = null;
/** The window conversation this proxy last saw (harnesses whose proxy survives /clear). */
let knownConversation: string | undefined;

/**
 * RTSC-1155 — a harness that RESTARTS its MCP servers on /clear or /resume (Pi; possibly
 * Codex and Grok) leaves the previous proxy's claims behind with nobody renewing them,
 * and the new conversation can neither continue nor release them. Take them over: each
 * through the RTSC-658 resume door (`claim_issue` with the token the previous proxy left),
 * which moves the live lease onto this session. Then tell the conversation, like Claude
 * Code's /clear does. Best effort throughout; a claim that lapsed or moved is skipped.
 */
async function adoptOrphanedClaims(): Promise<void> {
  if (UNBOUND || !KEY) return;
  // Claude Code never restarts its proxy on /clear, and its window is found another way;
  // nothing to take over there, and a nested `claude -p` must never reach the outer one.
  if (!clientName || /claude/i.test(clientName)) return;
  // Only onto this session's OWN key. A retired tool, or a session whose key mint failed,
  // is running on the shared workspace key, which must never pick up claims (RTSC-1014).
  if (harnessRetired || sessionKeyFallback || activeKey === KEY) return;
  const w = await resolveWindow();
  if (w === null) return;
  knownConversation = readWindowConversation(w)?.sessionId;
  const adopted: string[] = [];
  for (const orphan of readOrphanedLeases(w, process.pid, BINDING_ID)) {
    for (const [id, token] of Object.entries(orphan.tokens)) {
      if (leases.has(id)) continue;
      try {
        const body = {
          jsonrpc: "2.0",
          id: hbSeq--,
          method: "tools/call",
          params: { name: "claim_issue", arguments: { identifier: id, claimToken: token } },
        };
        const result = toolResult(await postRemote(body), "claim_issue");
        const fresh = (result as { claimToken?: unknown } | null)?.claimToken;
        const rebound = (result as { rebound?: unknown } | null)?.rebound === true;
        if (result && !isToolError(result) && typeof fresh === "string") {
          if (rebound) {
            leases.set(id, fresh);
            leaseUntil.set(id, expiryOf(result, Date.now()));
            adopted.push(id);
          } else {
            // The old lease had lapsed or been released, and the server made this a FRESH
            // claim: work nobody in this conversation asked for. Give it straight back.
            await postRemote({
              jsonrpc: "2.0",
              id: hbSeq--,
              method: "tools/call",
              params: { name: "release_issue", arguments: { identifier: id, claimToken: fresh } },
            }).catch(() => {});
            log(`${id} had already lapsed; not taken over`);
          }
        }
      } catch (e) {
        log(`could not take over ${id}: ${String((e as any)?.message ?? e)}`);
      }
    }
    try {
      unlinkSync(orphan.path);
    } catch {
      /* already gone */
    }
  }
  if (!adopted.length) return;
  adopted.sort();
  syncLeaseFile(true);
  pendingNotice = leaseNotice(adopted);
  log(`took over ${adopted.join(", ")} from the previous conversation in this window`);
}

/**
 * RTSC-1155 — for a harness whose proxy survives /clear, its hook records the window's
 * current conversation; when that changes while this proxy holds claims, queue the notice.
 * Not Claude Code: its SessionStart hook tells the new conversation itself.
 */
function checkConversationChange(before: Leases): void {
  // Not Claude Code (its SessionStart hook tells the conversation), and not Codex (its
  // UserPromptSubmit hook prints the same notice straight to the model; twice is noise).
  if (!clientName || /claude|codex/i.test(clientName)) return;
  const w = harnessPid();
  if (w === null) return;
  const cur = readWindowConversation(w)?.sessionId;
  if (!cur) return;
  if (knownConversation === undefined) {
    knownConversation = cur;
    return;
  }
  if (cur === knownConversation) return;
  knownConversation = cur;
  // What the window held BEFORE this call: a claim the new conversation just made is its
  // own, and telling it to release that would be exactly wrong.
  const now = Date.now();
  const held = [...before.keys()].filter((id) => leases.has(id) && (leaseUntil.get(id) ?? 0) > now).sort();
  if (held.length) pendingNotice = sharedWindowNotice(held);
}

/** RTSC-1155 — attach the queued notice to a successful result, once. */
function attachPendingNotice(resp: unknown): void {
  if (!pendingNotice) return;
  const result = (resp as any)?.result;
  if (!result || result.isError || !Array.isArray(result.content)) return;
  result.content.push({ type: "text", text: pendingNotice });
  pendingNotice = null;
}

/** RTSC-1150 — mark the leases one observed call took as confirmed until their expiry. */
function noteClaimed(before: Leases, result: unknown): void {
  const now = Date.now();
  const items = (result as { issues?: unknown })?.issues;
  for (const [id, token] of leases) {
    if (before.get(id) === token) continue;
    const item = Array.isArray(items) ? items.find((it) => it && (it as { id?: unknown }).id === id) : undefined;
    leaseUntil.set(id, expiryOf(item ?? result, now));
  }
}

/**
 * RTSC-1150 — leave the issue ids we hold where the window's SessionStart hook reads them
 * on /clear or /resume, so the conversation that inherits them is told. Ids only: the
 * tokens stay in memory. Only leases the server confirmed and that have not expired since
 * are listed; a lease we keep trying to renew while every heartbeat fails is not "held"
 * for the purpose of telling an agent to carry on with it. Written when the list changes,
 * and on every heartbeat tick (`refresh`). Deleted when nothing is listed.
 */
function syncLeaseFile(refresh: boolean): void {
  const now = Date.now();
  for (const id of [...leaseUntil.keys()]) if (!leases.has(id)) leaseUntil.delete(id);
  const live = [...leases.keys()].filter((id) => (leaseUntil.get(id) ?? 0) > now).sort();
  const key = live.join(",");
  if (!refresh && key === leaseFileWritten) return;
  // Recorded even when no harness is known yet: the next tick is the retry, and every
  // tool call in between would otherwise walk the ancestors again for nothing.
  leaseFileWritten = key;
  const pid = harnessPid();
  if (pid === null) return;
  if (leaseFileHarness !== null && leaseFileHarness !== pid) removeLeaseFile(leaseFileHarness, process.pid);
  leaseFileHarness = pid;
  const until = live.length ? Math.min(...live.map((id) => leaseUntil.get(id)!)) : now;
  // RTSC-1155 — with each claim's token, so a proxy the harness restarts can take over.
  const tokens = Object.fromEntries(live.map((id) => [id, leases.get(id)!]));
  writeLeaseFile(pid, { proxyPid: process.pid, at: now, until, issues: live, tokens, binding: BINDING_ID });
}

/** RTSC-1194 — one heal at a time, at most one a minute, and a handful per session, so a
 *  server that keeps refusing cannot turn this proxy into a key mint. */
let healInFlight: Promise<boolean> | null = null;
let lastHealAt = 0;
let heals = 0;
const HEAL_MIN_INTERVAL_MS = Number(process.env.RETASC_HEAL_MIN_INTERVAL_MS) || 60_000;
const HEAL_MAX_PER_SESSION = 10;

/**
 * RTSC-1194 — replace a session key the SERVER expired, without a restart.
 *
 * Until RTSC-1194 the server swept any session key not used within an HOUR of its mint as
 * an orphan, and a resumed conversation's proxy never makes that first call (no fresh
 * transcript record, so no `record_session`). An agent that spent an hour on other work
 * came back to a session where every Retasc call failed, and nothing short of a restart
 * recovered it. The server now waits seven days; this makes the rest of that case cost
 * one retry instead of the session.
 *
 * ONLY for "session key expired", which `resolveAuth` says only for a key a sweep retired
 * (`revokedReason: "unadopted"`). A key a person revoked keeps saying "has been revoked"
 * and is never healed around, so revoking one runaway session still stops it. The mint is
 * the second fence: it runs on the SAME parent, and the server refuses it when the parent
 * was revoked, the agent retired or suspended, or the project is being deleted.
 *
 * Claims are left exactly as they are. Every call that carries a claim token passes the
 * holder check from any of this agent's keys (`assertHolds` matches the token first), so
 * the watchdog's heartbeats keep renewing them from the new key and the tokens the agent
 * holds stay valid. Moving them with `claim_issue` would mint new tokens behind the agent's
 * back, and on a lease that had lapsed would quietly take the work again.
 */
async function healSessionKey(): Promise<boolean> {
  if (healInFlight) return healInFlight;
  // `sessionParent` is set only by a successful session mint, so a session running on the
  // workspace key (its mint failed) or a retired tool already stops at the first test; the
  // other two are defence in depth, kept so a future change to either path cannot heal there.
  if (!sessionParent || activeKey === KEY || harnessRetired) return false;
  if (heals >= HEAL_MAX_PER_SESSION || Date.now() - lastHealAt < HEAL_MIN_INTERVAL_MS) return false;
  lastHealAt = Date.now();
  heals += 1;
  const parent = sessionParent;
  healInFlight = (async () => {
    // Never rejects: a caller awaiting this is mid-forward, and a throw here would replace
    // the server's own reply with "forward failed".
    try {
      const label = process.env.RETASC_SESSION_LABEL || `${hostname()}#${process.pid}`;
      const outcome = await mintSessionKey({ url: MCP_URL, key: parent, label, cliVersion: VERSION, autoUpdate: autoUpdateReport(), warn: log, fallbackNotice: false });
      if (!outcome.ok) {
        log(
          "this session's key expired and no replacement could be minted (the tool or agent may have been " +
            "retired, its key rotated, or the server unreachable) — trying again at most once a minute; " +
            "restart the session if it persists",
        );
        return false;
      }
      activeKey = outcome.key;
      authWarned = false;
      log(`this session's key had expired unused — replaced it with "${outcome.session ?? label}"`);
      // The conversation record lives on the key that reported it, so say it again on this
      // one. Only when there is one to say: a resumed session that never found its record
      // has nothing to repeat, and its retried call adopts the new key regardless.
      if (transcriptRecorded && transcript) {
        const t = transcript;
        recordSession({
          url: MCP_URL,
          key: activeKey,
          transcriptId: t.id,
          harness: t.harness,
          model: reportedModel ?? t.model,
          agentType: t.agentType,
          agentId: t.agentId,
          transcriptKeepDays: transcriptKeep,
          warn: log,
        }).catch((e) => log(`record_session: ${String((e as any)?.message ?? e)}`));
      }
      return true;
    } catch (e) {
      log(`could not replace this session's expired key: ${String((e as any)?.message ?? e)}`);
      return false;
    }
  })().finally(() => {
    healInFlight = null;
  });
  return healInFlight;
}

/** RTSC-1194 — the refusal was for a key we have since replaced: retry, do not heal again. */
function expiredAndStale(result: unknown, sentWith: string): boolean {
  return isSessionKeyExpired(result) && activeKey !== sentWith;
}

async function heartbeatAll(): Promise<void> {
  for (const [issueId, token] of [...leases]) {
    try {
      const sentWith = activeKey;
      let result = toolResult(await postRemote(heartbeatRequest(hbSeq--, issueId, token)), "heartbeat");
      // RTSC-1194 — an expired session key is replaced (or already was, by a call in
      // flight) and this renewal sent again on the new key, with the same token.
      if (expiredAndStale(result, sentWith) || (isSessionKeyExpired(result) && (await healSessionKey()))) {
        result = toolResult(await postRemote(heartbeatRequest(hbSeq--, issueId, token)), "heartbeat");
      }
      if (isClaimLost(result)) {
        leases.delete(issueId);
        log(`lease for ${issueId} is gone — stopped tracking`);
      } else if (isSessionKeyExpired(result)) {
        // RTSC-1194 — expired and not replaced yet (paced, capped, or the mint refused). Not
        // the RTSC-646 warning below, which would blame a revoke nobody made.
        log(`heartbeat for ${issueId}: this session's key expired and is not replaced yet — lease not renewed this tick`);
      } else if (isUnauthorized(result)) {
        // RTSC-646: the credential died, not the lease. Every claim in this session
        // stops renewing at once and lapses at its own expiry, which reads exactly
        // like "the watchdog is working" until the reclaimer takes the work away.
        // Keep tracking and keep trying — re-minting the key inside the TTL recovers
        // every lease — but say the cause out loud, once.
        if (!authWarned) {
          authWarned = true;
          log(
            `warning: heartbeat for ${issueId} was rejected as UNAUTHORIZED — this session's key ` +
              `no longer authenticates (revoked or rotated key, revoked parent key, or a suspended/` +
              `retired member). NO lease in this session is being renewed now; each one lapses at ` +
              `its own expiry and the reclaimer hands the work to another agent. Restore the ` +
              `credential and restart this session, or finish and release your claims by hand.`,
          );
        } else {
          log(`heartbeat for ${issueId} still UNAUTHORIZED — lease not renewed`);
        }
      } else {
        // A renewal that worked proves the credential works, so arm the full
        // warning again: a key re-minted mid-session and then revoked a second
        // time deserves the same loud explanation as the first time.
        authWarned = false;
        // RTSC-1150 — and confirms the lease for the window's list. Any other error
        // leaves the last confirmation to run out on its own.
        if (result && !isToolError(result)) leaseUntil.set(issueId, expiryOf(result, Date.now()));
      }
    } catch (e) {
      log(`heartbeat for ${issueId} failed: ${String((e as any)?.message ?? e)}`);
    }
  }
  // RTSC-1150 — after the tick, not before: a lease found gone is off the list, and one
  // whose renewals keep failing drops off once its last confirmed expiry passes.
  syncLeaseFile(true);
}

/** Run the stdio proxy. Started by the harness; lives as long as the session. */
export async function runProxy(): Promise<void> {
  if (UNBOUND) log(UNBOUND_MESSAGE);
  else if (!KEY) log("warning: RETASC_MCP_KEY is empty — forwarded requests will be unauthorized");
  // RTSC-1014 — the session key is NO LONGER minted here. It hangs off this tool's
  // harness credential, and nothing names the tool until `initialize` arrives, so the
  // mint moved into that handler (`adoptHarnessKey`). The promise the startup mint was
  // written for still holds: `initialize` is the first message any MCP client sends, so
  // no claim can precede it and every claim is still attributed to this session.
  //
  // A client that never handshakes (a raw probe) keeps the workspace key, which is what
  // it got before this tier existed.
  await announceBinding();
  // RTSC-1154 — correct hook entries this machine got from an older CLI (Gemini's
  // millisecond timeout, OpenCode's plugin). Deferred: nothing here may slow the start.
  setTimeout(() => {
    try {
      const healed = healHookEntries();
      if (healed.length) log(`corrected: ${healed.join(", ")}`);
    } catch {
      /* best effort */
    }
  }, 2000).unref?.();
  // RTSC-1153 — keep this machine current. Once a day at most, in a detached child that
  // asks npm and, if this build is behind, hands over to the newest one; this session
  // carries on untouched and the next one starts the new build.
  const au = maybeStartAutoUpdate({
    env: process.env,
    now: Date.now(),
    claimSlot: claimAutoUpdateSlot,
    config: loadConfig,
    spawnUpdate: () => spawnDetachedUpdate(CLI_ENTRY, VERSION),
  });
  if (au === "started") log("checking for a newer retasc in the background");
  // RTSC-825 — the folder this session runs in IS its workspace, and this process is
  // the only thing that knows it. Sent on the WORKSPACE key (not the session child just
  // adopted), so a folder bound before the CLI reported one, or renamed since, corrects
  // itself the next time an agent starts. A no-op server-side when it already matches.
  //
  // The BOUND folder, not the cwd. The `auto` marker resolves this key by walking up
  // from wherever the harness was started, so a session opened in `retasc/dash` runs on
  // `retasc`'s key — naming it `dash` would be wrong, and the next session from the root
  // would rename it back, flapping the row on every start. Empty for a key that came
  // from the environment rather than the keystore: that one names no folder.
  const BOUND_FOLDER = resolved.boundPath ? basename(resolved.boundPath) : "";
  if (KEY && BOUND_FOLDER) {
    nameWorkspace({ url: MCP_URL, key: KEY, workspace: BOUND_FOLDER, warn: log }).catch((e) =>
      log(`name_workspace: ${String((e as any)?.message ?? e)}`),
    );
  }
  // RTSC-1014 — no `reportTranscript()` here any more. It needs a session key, and the
  // session key is now minted at the handshake, so a call here could only ever no-op.
  const timer = setInterval(() => void heartbeatAll(), HEARTBEAT_MS);
  // RTSC-1150 — a proxy that is gone renews nothing, so its list must not outlive it.
  // Node's default for these signals ends the process WITHOUT an 'exit' event, and a
  // harness shutting its MCP servers down usually sends one, so each is caught once,
  // the file removed, and the signal raised again to end the process as it would have.
  // A kill that skips all of this (SIGKILL, a crash) is covered by the hook, which checks
  // the pid and the list's expiry.
  // RTSC-1155 — but NOT while the window itself is still alive and this proxy held
  // claims: that is a harness restarting its MCP server on /clear or /resume (Pi closes it
  // with stdin-close then SIGTERM, cleanly), and the proxy it starts next takes the claims
  // over from exactly this file. `readHeldIssues` never believes a dead proxy's list, and
  // the adopter deletes it; a window that is gone takes its file with it here.
  const dropLeaseFile = () => {
    if (leaseFileHarness === null) return;
    const keepForSuccessor = clientName !== null && !/claude/i.test(clientName) && leases.size > 0 && processAlive(leaseFileHarness);
    if (!keepForSuccessor) removeLeaseFile(leaseFileHarness, process.pid);
  };
  process.on("exit", dropLeaseFile);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(sig, () => {
      dropLeaseFile();
      process.kill(process.pid, sig);
    });
  }
  timer.unref?.(); // the timer alone must not keep the process alive
  const rl = createInterface({ input: process.stdin });
  // RTSC-1014 — SERIALISED. `handleLine` is async, and the harness mint it now performs on
  // `initialize` takes a round trip; unserialised, anything arriving during that window is
  // forwarded on the WORKSPACE key before the handshake has decided whether this tool is
  // even allowed to run — so a retired tool gets a head start on the credential it is
  // supposed to have lost. The pre-1014 code had the same shape and did not need this,
  // because its only await before serving finished before `createInterface` was reached.
  //
  // A promise chain rather than a queue object: order is already guaranteed by readline,
  // so all this adds is "wait for the previous one", and a rejection is swallowed so one
  // bad line cannot break the chain for every line after it (`handleLine` reports its own
  // failures as JSON-RPC errors).
  let inFlight: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    inFlight = inFlight.then(() => handleLine(line)).catch(() => {});
  });
  rl.on("close", () => {
    // Don't hard-exit: let in-flight forwards finish and write their responses.
    // With stdin closed and the timer unref'd, the process exits once the event
    // loop drains. (In a real harness stdin stays open for the whole session.)
    clearInterval(timer);
  });
  log(`up → ${MCP_URL} (heartbeat every ${Math.round(HEARTBEAT_MS / 60000)}m)`);
}
