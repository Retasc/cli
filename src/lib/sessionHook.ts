import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { writeAtomic } from "./fsAtomic.js";
import { findWindowPid } from "./conversation.js";

// RTSC-820 — how a harness's session id reaches the proxy.
//
// The proxy is what talks to Retasc, and it is spawned by the harness as an MCP server:
// it knows its cwd and its key, and nothing about the conversation it serves. The
// harness knows the conversation's id (Claude Code writes `<uuid>.jsonl` under
// ~/.claude/projects/<folder>/) and, for Claude Code, hands it to HOOKS, not to MCP
// servers. So `retasc setup` wires a SessionStart hook whose command is
// `retasc hook session-start`; the hook reads the harness's JSON on stdin and drops a
// small record in the keystore dir; the proxy picks it up and calls `record_session`.
//
// Hook and proxy start in either order (both are spawned at session start), so the
// file is the meeting point and the proxy keeps looking for a while (proxy.ts).
//
// Matching is by the FOLDER, which is all the two processes are guaranteed to share:
// the hook's `cwd` is the project directory, and the proxy's `process.cwd()` is the
// same directory (RTSC-780 admits a harness only if its stdio servers start there).
// `at` keeps a record from an earlier session from being adopted by a later one: the
// proxy accepts only a record written within a minute before its own start, or after
// it. Two sessions opened in one folder inside that minute could still cross; there is
// no field the hook and the proxy both see that would tell them apart (the hook runs
// under a shell the harness spawns, so even the parent pid differs), and a minute is
// the honest window.
//
// Grok needs none of this: it exports GROK_SESSION_ID to MCP servers directly.

export type HookRecord = {
  harness: string;
  sessionId: string;
  cwd: string;
  at: number;
  // RTSC-821 — what the payload said beyond the id. All optional: Claude Code omits
  // `model` from some SessionStart payloads, and `agentType`/`agentId` exist only when
  // the session is a subagent or was started with `--agent`.
  model?: string;
  agentType?: string;
  agentId?: string;
  /**
   * RTSC-832 — where the harness writes this conversation, so the PROXY can read the
   * model out of it. Claude Code 2.1.261 sends no `model` on SessionStart (the payload
   * is session_id, transcript_path, cwd, hook_event_name, source — captured 2026-09-05),
   * but it writes one on every assistant message in the transcript.
   *
   * LOCAL ONLY. This never becomes an argument to `record_session`, never reaches the
   * server, and never appears in `listKeys`: an absolute path bakes in a username and
   * resolves on one machine (RTSC-791), and RTSC-820 decided we keep the NAME of a
   * transcript and never its contents. Only the model STRING is sent.
   */
  transcriptPath?: string;
};

/** Where the records live. `RETASC_DIR` relocates it, like the keystore (tests, sandboxes). */
export function sessionsDir(): string {
  return join(process.env.RETASC_DIR || join(homedir(), ".retasc"), "sessions");
}

/** The folder as the kernel names it: the hook's `cwd` and the proxy's `process.cwd()`
 *  may spell a symlinked path differently, and both must land on one file. */
export function canonPath(p: string): string {
  const r = resolve(p);
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
}

/** One file per folder: a stable, filename-safe key for the cwd. */
export function hookFilePath(cwd: string, dir = sessionsDir()): string {
  const h = createHash("sha256").update(canonPath(cwd)).digest("hex").slice(0, 16);
  return join(dir, `${h}.json`);
}

/** Records nobody consumed in a day are nobody's session any more: dropped on the next
 *  write, so the dir never becomes an index of every folder ever opened. Best effort. */
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
function sweepOldRecords(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const path = join(dir, n);
      if (now - statSync(path).mtimeMs > RECORD_TTL_MS) unlinkSync(path);
    } catch {
      /* someone else's problem */
    }
  }
}

/**
 * What a hook writes. Never throws past its caller: a hook that fails must not fail the
 * harness's session start, and the worst case is the Dash saying "none recorded".
 */
export function writeHookRecord(rec: HookRecord, dir = sessionsDir()): string {
  const path = hookFilePath(rec.cwd, dir);
  // RTSC-822 — A RE-REPORT OF THE SAME SESSION IS NOT NEWS, AND `at` MUST NOT MOVE.
  //
  // `at` is the window that stops one session's record being adopted by a later process
  // in the same folder (see `readHookRecord`). Every re-fire that refreshed it would keep
  // a record looking new for as long as the session lives, which defeats the window.
  //
  // This is not hypothetical and not only Codex's problem. Codex has no SessionStart at
  // all, so its hook rides `UserPromptSubmit` and fires on EVERY prompt. Claude Code
  // re-fires SessionStart on resume with the SAME id — the `startup|resume|clear` matcher
  // narrows that but does not remove it. Both are the same event: "told again what we
  // already know".
  //
  // So the rule lives HERE rather than at a call site: every caller gets it, and a
  // harness adapter added later cannot forget it. Anything that actually CHANGED still
  // writes — a new id, a model that arrived late, a transcript path the first payload
  // lacked — and `at` moves only with it, because then it really is a new fact.
  const prior = readHookRecord(rec.cwd, { dir, maxAgeMs: Number.POSITIVE_INFINITY });
  if (prior && !recordSaysMore(prior, rec)) return path;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
  sweepOldRecords(dirname(path), rec.at);
  return path;
}

/** Does `next` carry anything `prior` did not? A different session, a different harness,
 *  or a field that was missing and has now arrived. Everything else is a repeat. */
function recordSaysMore(prior: HookRecord, next: HookRecord): boolean {
  if (prior.sessionId !== next.sessionId || prior.harness !== next.harness) return true;
  const grew = (a: string | undefined, b: string | undefined) => b !== undefined && b !== a;
  return grew(prior.model, next.model) || grew(prior.transcriptPath, next.transcriptPath) || grew(prior.agentType, next.agentType) || grew(prior.agentId, next.agentId);
}

/**
 * The record for THIS folder, if a hook left one recently enough to be this session's.
 * `maxAgeMs` is measured from `now`; the proxy passes its own start time so a record
 * written a little before the proxy came up still counts. `notAfter` is the other edge:
 * a record written well AFTER the proxy started belongs to the next session in this
 * folder, and a long-lived proxy that never found its own must not adopt it.
 */
export function readHookRecord(
  cwd: string,
  opts: { dir?: string; now?: number; maxAgeMs?: number; notAfter?: number } = {},
): HookRecord | null {
  const path = hookFilePath(cwd, opts.dir ?? sessionsDir());
  if (!existsSync(path)) return null;
  let rec: HookRecord;
  try {
    rec = JSON.parse(readFileSync(path, "utf8")) as HookRecord;
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object") return null;
  // Same shape the server accepts: a filename stem, never something a shell or a CLI
  // would read as a flag (first character alphanumeric).
  if (typeof rec.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(rec.sessionId)) return null;
  if (typeof rec.harness !== "string" || !rec.harness) return null;
  if (typeof rec.cwd !== "string" || canonPath(rec.cwd) !== canonPath(cwd)) return null;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 10 * 60 * 1000;
  if (typeof rec.at !== "number" || rec.at > now + 60_000 || now - rec.at > maxAge) return null;
  if (opts.notAfter !== undefined && rec.at > opts.notAfter) return null;
  // RTSC-821 — a junk model must not take the record down with it: the id is the
  // valuable part and the model is a bonus, so a bad one is dropped, not fatal.
  return {
    harness: rec.harness,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    at: rec.at,
    ...(ident(rec.model, 60) ? { model: ident(rec.model, 60)! } : {}),
    ...(ident(rec.agentType, 60) ? { agentType: ident(rec.agentType, 60)! } : {}),
    ...(ident(rec.agentId, 100) ? { agentId: ident(rec.agentId, 100)! } : {}),
    ...(typeof rec.transcriptPath === "string" && rec.transcriptPath ? { transcriptPath: rec.transcriptPath } : {}),
  };
}

/**
 * The model the harness is CURRENTLY running, read out of the transcript it writes
 * (RTSC-832).
 *
 * Claude Code never puts `model` in the SessionStart payload, so this is the only source
 * that works for a session nobody has run `/model` in — which is most of them. Each
 * assistant message in the `.jsonl` carries `message.model`, and the LAST one is the
 * model in force now, so a `/model` switch is picked up by the same read.
 *
 * Reads the TAIL only. Transcripts reach 24MB in this repo, and this is called on a
 * throttle for the life of a session; pulling the whole file each time would be a
 * megabyte-scale read on the proxy's response path. The last chunk is where the newest
 * message is, and a line straddling the chunk boundary is simply skipped as unparseable.
 *
 * Never throws: a missing, empty, truncated or half-written file just means no model
 * this time, exactly as a harness that reports none.
 */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
/** The one retry, for a session whose newest message is bigger than the window. */
const TRANSCRIPT_WIDE_BYTES = 2 * 1024 * 1024;

export function modelFromTranscript(path: string, tailBytes = TRANSCRIPT_TAIL_BYTES): string | undefined {
  // A single assistant message can exceed the window: 563 lines over 64KB exist on this
  // machine, the largest 1.18MB. The window then holds only that line's tail fragment,
  // which is not parseable JSON, and the read would report nothing at all. So a scan
  // that finds nothing widens once before giving up.
  return scanTail(path, tailBytes) ?? (tailBytes < TRANSCRIPT_WIDE_BYTES ? scanTail(path, TRANSCRIPT_WIDE_BYTES) : undefined);
}

function scanTail(path: string, tailBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    const st = statSync(path);
    // isFile FIRST, and it is load-bearing: `openSync` on a FIFO with no writer blocks
    // forever, and this runs on the proxy's synchronous response path. The size check
    // happened to prevent that before; relying on that ordering was an accident.
    if (!st.isFile() || !st.size) return undefined;
    const start = Math.max(0, st.size - tailBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    // The harness is APPENDING to this file. A short read, or a truncation between the
    // stat and the read, leaves the rest of the zero-filled buffer glued to the newest
    // line, which then fails to parse and silently yields an older model. Only the bytes
    // actually read are text.
    const n = readSync(fd, buf, 0, len, start);
    if (!n) return undefined;
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    // Backwards: the newest assistant message wins, so a mid-session switch lands.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== "{") continue;
      try {
        const j = JSON.parse(line) as any;
        // ONLY a top-level assistant turn. Measured across 40 real transcripts, MCP
        // sampling records (`attributionMcpServer` / `attributionMcpTool`, 91-271 per
        // file) also carry `message.model`, and so do sidechain entries — a subagent on
        // a different model would otherwise be reported as the session's model, and each
        // flip would spend one of the 40 lookups plus a server round trip.
        // `type: "assistant"` alone is NOT enough: a sampling record wears it too.
        if (j?.type !== "assistant") continue;
        if (j?.isSidechain || j?.attributionMcpServer || j?.attributionMcpTool) continue;
        const m = ident(j?.message?.model, 60);
        if (m) return m;
      } catch {
        /* a truncated line, or the one straddling the chunk edge */
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/**
 * Rewrite the model on the record for this folder, in place (RTSC-821).
 *
 * `at` is deliberately LEFT ALONE. It is the freshness window that stops a record
 * written for an earlier session being adopted by a later one, and a `/model` switch
 * an hour into a conversation must not make an hour-old record look new. A switch in a
 * folder with no record is a no-op: there is no session here to describe.
 *
 * `sessionId` is REQUIRED to match when the record has one. The file is keyed by FOLDER
 * (`hookFilePath` is a hash of the cwd, nothing else), so two Claude Code sessions open
 * in one directory share it: without this check, resuming or switching in session B
 * would rewrite the model that session A's still-live proxy is about to report, and A
 * would stamp B's model onto its own key. `PostModelSwitch` also fires on `resume`,
 * which makes that a routine event rather than a race you would have to try for.
 */
export function updateHookRecordModel(cwd: string, model: string, sessionId?: string, dir = sessionsDir()): boolean {
  const path = hookFilePath(cwd, dir);
  try {
    if (!existsSync(path)) return false;
    const rec = JSON.parse(readFileSync(path, "utf8")) as HookRecord;
    if (!rec || typeof rec !== "object" || typeof rec.at !== "number") return false;
    // A payload with no session id cannot prove ownership, so it does not get to write.
    if (!sessionId || rec.sessionId !== sessionId) return false;
    if (rec.model === model) return false;
    writeFileSync(path, JSON.stringify({ ...rec, model }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Consume a record once it has been reported, so no later session can adopt it. */
export function clearHookRecord(cwd: string, dir = sessionsDir()): void {
  try {
    unlinkSync(hookFilePath(cwd, dir));
  } catch {
    /* already gone */
  }
}

// --- RTSC-1150: the harness PROCESS, and the claims its window still holds -----------
//
// The folder record above answers "which session started in this folder lately", and
// that cannot say which WINDOW: several Claude Code windows in one folder is the
// ordinary setup, and each start overwrites the one file. So the hook also leaves a
// record keyed by the harness process, which only that process's hooks write and which a
// pid cannot share while it is alive. The proxy walks its own ancestry to find it
// (lib/conversation.ts), and from then on keeps a LEASE FILE under the same pid, so the
// hook can tell a conversation started by `/clear` which claims the window still holds.

/** A harness process and the conversation it is running now. */
export type HarnessRecord = { pid: number; sessionId: string; at: number };

export function harnessFilePath(pid: number, dir = sessionsDir()): string {
  return join(dir, `pid-${pid}.json`);
}

/**
 * The Claude Code process this hook runs under. Claude Code sets `CLAUDE_PID` on every
 * child it spawns, hooks included (measured on 2.1.282). Anything else answers nothing,
 * and a harness that answers nothing gets no record and no notice.
 */
export function harnessPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = (env.CLAUDE_PID ?? "").trim();
  return /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : undefined;
}

/** Written on every session start, repeats included: the rewrite is what keeps a window
 *  open for days ahead of the 24h sweep. Never throws. */
export function writeHarnessRecord(rec: HarnessRecord, dir = sessionsDir()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(harnessFilePath(rec.pid, dir), JSON.stringify(rec), { mode: 0o600 });
    sweepOldRecords(dir, rec.at);
  } catch {
    /* never fail the harness's session start */
  }
}

export function readHarnessRecord(pid: number, dir = sessionsDir()): HarnessRecord | null {
  try {
    const path = harnessFilePath(pid, dir);
    if (!existsSync(path)) return null;
    const rec = JSON.parse(readFileSync(path, "utf8")) as HarnessRecord;
    if (!rec || typeof rec !== "object" || rec.pid !== pid || typeof rec.at !== "number") return null;
    // Same shape as the folder record's id: a filename stem, first character alphanumeric.
    if (typeof rec.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(rec.sessionId)) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * What a proxy leaves for its harness's hooks: the issues it is renewing, and (RTSC-1155)
 * each one's claim token.
 *
 * RTSC-1150 kept tokens off disk: in Claude Code the new conversation talks through the
 * same proxy, on the same session key, and needs none. RTSC-1155 changed that on the
 * founder's decision (2026-09-28): Pi, and possibly Codex and Grok, RESTART the proxy on
 * /clear or /resume, and the new proxy is a different session that can neither continue
 * nor release the old claim without its token, nor can anyone else take it, for up to 30
 * minutes. With the token it takes the claim over through the RTSC-658 resume door.
 * The file is 0600 in the 0700 `~/.retasc/sessions`, beside a keystore that already holds
 * the far stronger workspace key, and it is deleted when the claim ends or is adopted.
 */
export type LeaseFile = {
  proxyPid: number;
  at: number;
  until: number;
  issues: string[];
  tokens?: Record<string, string>;
  /** RTSC-1155 — which server and credential the tokens belong to (a hash, never the key),
   *  so a proxy on another binding in the same window never sends them anywhere. */
  binding?: string;
};

const BINDING = /^[a-f0-9]{16}$/;

/** A claim token as the server issues it. Shape-checked before it is written or used. */
const TOKEN = /^[A-Za-z0-9-]{8,100}$/;

/** One file per PROXY under a harness, so two Retasc servers in one window cannot
 *  overwrite each other's list. The hook reads all of them. */
export function leaseFilePath(harnessPid: number, proxyPid: number, dir = sessionsDir()): string {
  return join(dir, `pid-${harnessPid}-leases-${proxyPid}.json`);
}

const ISSUE_ID = /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/;

/**
 * Write the proxy's current lease list, or delete the file when it holds nothing.
 * `issues` are the leases the server last CONFIRMED (a claim or a heartbeat that
 * succeeded) and that have not expired since; `until` is the earliest of their expiries.
 * Past `until` the list is not believed at all: a proxy whose renewals are failing
 * (offline, a revoked key) keeps its leases in memory, and a list that outlived them
 * would tell a conversation "carry on" about work the reclaimer already handed away.
 * Rewritten on every change and every heartbeat tick. Never throws.
 */
export function writeLeaseFile(harnessPid: number, rec: LeaseFile, dir = sessionsDir()): void {
  try {
    const path = leaseFilePath(harnessPid, rec.proxyPid, dir);
    const issues = [...new Set(rec.issues)].filter((id) => ISSUE_ID.test(id)).sort();
    if (!issues.length) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Written aside and renamed in, so a hook reading at the same moment sees the old
    // list or the new one, never half of one. The temp name does not end in `.json`, so
    // neither the reader nor the 24h sweep ever mistakes it for a list.
    const tmp = `${path}.${process.pid}.tmp`;
    const tokens: Record<string, string> = {};
    for (const id of issues) {
      const t = rec.tokens?.[id];
      if (typeof t === "string" && TOKEN.test(t)) tokens[id] = t;
    }
    writeFileSync(
      tmp,
      JSON.stringify({
        proxyPid: rec.proxyPid,
        at: rec.at,
        until: rec.until,
        issues,
        ...(Object.keys(tokens).length ? { tokens } : {}),
        ...(rec.binding && BINDING.test(rec.binding) ? { binding: rec.binding } : {}),
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } catch {
    /* a missing notice is the worst case; never break a tool call over it */
  }
}

export function removeLeaseFile(harnessPid: number, proxyPid: number, dir = sessionsDir()): void {
  try {
    unlinkSync(leaseFilePath(harnessPid, proxyPid, dir));
  } catch {
    /* already gone */
  }
}

export function processAlive(pid: number): boolean {
  return pidAlive(pid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: another user's process, which our own proxy never is.
    return false;
  }
}

/**
 * The issues the proxies under `harnessPid` are still renewing, sorted, deduplicated.
 * A file is believed only while its proxy is alive and before its `until`: a proxy
 * killed without cleanup (SIGKILL, a crash) leaves a file behind, and a stale file must
 * never tell a conversation it holds claims that have lapsed. Never throws.
 */
export function readHeldIssues(
  harnessPid: number,
  dir = sessionsDir(),
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): string[] {
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = `pid-${harnessPid}-leases-`;
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf8")) as LeaseFile;
      if (!rec || typeof rec.proxyPid !== "number" || typeof rec.until !== "number" || !Array.isArray(rec.issues)) continue;
      if (n !== `${prefix}${rec.proxyPid}.json`) continue;
      if (now >= rec.until || !alive(rec.proxyPid)) continue;
      for (const id of rec.issues) if (typeof id === "string" && ISSUE_ID.test(id)) out.add(id);
    } catch {
      /* unreadable: says nothing */
    }
  }
  return [...out].sort();
}

/**
 * RTSC-1155 — the claims a DEAD proxy in this window left behind, with their tokens, for
 * a proxy the harness restarted (on /clear or /resume) to take over. Only files whose
 * proxy is gone and that were written recently: a window closed an hour ago left claims
 * that are the reclaimer's now. Each file is returned with its path so the adopter can
 * delete it once it has tried. Never throws.
 */
export const ADOPT_WITHIN_MS = 30 * 60 * 1000;

export function readOrphanedLeases(
  harnessPid: number,
  selfPid: number,
  binding: string,
  dir = sessionsDir(),
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): { path: string; tokens: Record<string, string> }[] {
  const out: { path: string; tokens: Record<string, string> }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  const prefix = `pid-${harnessPid}-leases-`;
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf8")) as LeaseFile;
      if (!rec || typeof rec.proxyPid !== "number" || rec.proxyPid === selfPid) continue;
      if (n !== `${prefix}${rec.proxyPid}.json`) continue;
      if (alive(rec.proxyPid) || typeof rec.at !== "number" || now - rec.at > ADOPT_WITHIN_MS) continue;
      // Another server or credential's claims (a second Retasc in the window, a dev/prod
      // pair) are not ours to send anywhere, and their file is not ours to remove.
      if (rec.binding !== binding) continue;
      const tokens: Record<string, string> = {};
      for (const id of Array.isArray(rec.issues) ? rec.issues : []) {
        const t = rec.tokens?.[id];
        if (typeof id === "string" && ISSUE_ID.test(id) && typeof t === "string" && TOKEN.test(t)) tokens[id] = t;
      }
      out.push({ path: join(dir, n), tokens });
    } catch {
      /* unreadable: says nothing */
    }
  }
  return out;
}

/**
 * RTSC-1155 — the window a HOOK runs in, for harnesses other than Claude Code (which names
 * itself with `CLAUDE_PID`): the nearest non-wrapper ancestor, as the proxy finds its own
 * (lib/conversation.ts). Hook and proxy are both children of the harness, so they land on
 * the same pid. Null when the process table cannot be read.
 */
export function hookWindowPid(): number | null {
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: 5_000 });
    const w = r.status === 0 ? findWindowPid(r.stdout ?? "", process.ppid) : null;
    // A Claude Code window is never another harness's to speak for (same rule as the proxy).
    return w !== null && readHarnessRecord(w) ? null : w;
  } catch {
    return null;
  }
}

/** RTSC-1155 — the Cursor hook that records the conversation on every prompt. Cursor's
 *  sessionStart fires only at a fresh launch, never on /clear or /resume (checked in its
 *  bundle), so the per-prompt hook is the only place a new conversation shows up. */
export const PROMPT_HOOK_VERB = "hook prompt";
/** Found by this, never by the bare verb: `hook prompt` alone is generic enough that
 *  another tool's beforeSubmitPrompt hook (a prompt guard) could contain it, and a
 *  substring match would then overwrite that hook with ours. */
export const PROMPT_HOOK_MARKER = "hook prompt --harness cursor";

/**
 * RTSC-1155 — which conversation a window is running now, for harnesses whose proxy
 * SURVIVES /clear (Gemini, Cursor, OpenCode, possibly Codex). Their hooks record it here,
 * keyed by the harness process; the proxy compares it with the one it last saw and, when
 * it changed while claims are held, tells the new conversation on its next Retasc call.
 * Claude Code needs none of this: its SessionStart hook tells the conversation directly.
 */
export type WindowConversation = { sessionId: string; at: number };

export function windowConversationPath(harnessPid: number, dir = sessionsDir()): string {
  return join(dir, `pid-${harnessPid}-conversation.json`);
}

/** Record the window's current conversation. Returns the one it replaces, if any. */
export function writeWindowConversation(harnessPid: number, sessionId: string, dir = sessionsDir(), now = Date.now()): string | null {
  const prev = readWindowConversation(harnessPid, dir)?.sessionId ?? null;
  if (prev === sessionId) return prev;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = windowConversationPath(harnessPid, dir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionId, at: now }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* a missing notice is the worst case */
  }
  return prev;
}

export function readWindowConversation(harnessPid: number, dir = sessionsDir()): WindowConversation | null {
  try {
    const rec = JSON.parse(readFileSync(windowConversationPath(harnessPid, dir), "utf8")) as WindowConversation;
    if (!rec || typeof rec.at !== "number" || typeof rec.sessionId !== "string") return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(rec.sessionId)) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * RTSC-1155 — the notice for a harness whose proxy SURVIVES a conversation change. There,
 * a change is not always a /clear: Cursor's IDE and OpenCode's server can run several
 * conversations behind one proxy, and switching between them looks the same. The claims
 * may be another live conversation's, so the new one is told to ASK before releasing.
 */
export function sharedWindowNotice(issues: string[]): string | null {
  if (!issues.length) return null;
  const list = issues.length === 1 ? issues[0] : `${issues.slice(0, -1).join(", ")} and ${issues[issues.length - 1]}`;
  const it = issues.length === 1 ? "it" : "them";
  return (
    `Retasc: this window's Retasc session still holds ${list}, claimed before this conversation began or by another conversation in this window, and keeps renewing ${it}. ` +
    `If you're continuing ${it}, carry on: you already hold ${it} and need no new claim. ` +
    `Otherwise do not release ${it} yourself: another conversation may be working on ${it}. Ask the user whether to keep or release ${it}.`
  );
}

/** The sources a held-claims notice goes out on. `startup` starts a new process, whose
 *  proxy holds nothing yet; `compact` keeps the conversation that took the claims. */
export const NOTICE_SOURCES = new Set(["clear", "resume"]);

/**
 * What the new conversation is told. Worded as a decision the agent owns, in the three
 * shapes it takes (RTSC-1150): continuing it, moving to other work, or not knowing which.
 */
export function leaseNotice(issues: string[]): string | null {
  if (!issues.length) return null;
  const list = issues.length === 1 ? issues[0] : `${issues.slice(0, -1).join(", ")} and ${issues[issues.length - 1]}`;
  const it = issues.length === 1 ? "it" : "them";
  return (
    `Retasc: this window still holds ${list} from the previous conversation, and its watchdog keeps renewing ${it}. ` +
    `If you're continuing ${it}, carry on: you already hold ${it} and need no new claim. ` +
    `If you're moving to other work, release ${it} first with \`release_issue\`, then claim the new work; if the release is refused, tell the user. ` +
    `If it isn't clear which, ask the user whether to keep or release ${it}. Don't ignore this.`
  );
}

/** The shape the server accepts, checked here so a junk value never leaves the machine
 *  (RTSC-821). Same charset as the transcript id: the Dash renders these. */
function ident(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${max - 1}}$`).test(t) ? t : undefined;
}

/**
 * Parse what Claude Code hands a SessionStart hook on stdin. Verified against the hooks
 * reference (2026-09-04): `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
 * `source`, and `model` / `agent_id` / `agent_type` when it has them.
 *
 * The transcript path IS kept (RTSC-832), reversing RTSC-820. That was dropped on
 * RTSC-791's rule that a path bakes in a username, and the rule still holds: it governs
 * what we SEND, and the path never leaves this machine. It is kept because 2.1.261 puts
 * no `model` in this payload at all, so the transcript is the only place the model
 * exists. See `HookRecord.transcriptPath`.
 *
 * `model` is absent from some payloads by design, so a parse that finds an id and no
 * model is a SUCCESS carrying less, never a failure.
 */
export function parseClaudeHookInput(stdin: string): { sessionId: string; cwd: string; source?: string; model?: string; agentType?: string; agentId?: string; transcriptPath?: string } | null {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return null;
  }
  const sessionId = typeof j?.session_id === "string" ? j.session_id.trim() : "";
  const cwd = typeof j?.cwd === "string" && j.cwd ? j.cwd : process.cwd();
  if (!sessionId) return null;
  return {
    sessionId,
    cwd,
    // RTSC-1150 — startup | resume | clear | compact. Decides whether the held-claims
    // notice goes out; never recorded.
    ...(ident(j?.source, 20) ? { source: ident(j.source, 20)! } : {}),
    ...(ident(j?.model, 60) ? { model: ident(j.model, 60)! } : {}),
    ...(ident(j?.agent_type, 60) ? { agentType: ident(j.agent_type, 60)! } : {}),
    ...(ident(j?.agent_id, 100) ? { agentId: ident(j.agent_id, 100)! } : {}),
    // Kept for the proxy to READ, never to send. See `HookRecord.transcriptPath`.
    ...(typeof j?.transcript_path === "string" && j.transcript_path ? { transcriptPath: j.transcript_path } : {}),
  };
}

/**
 * RTSC-1154 — correct the hook entries Retasc itself wrote on this machine, without
 * anyone re-running `setup`: the background update deliberately never re-wires, so a fix
 * to what we write would otherwise reach only new machines. Two, both plain file edits of
 * our own entries (never an add, never another tool's entry):
 *   - Gemini: our SessionStart entry's `timeout`, written as 10 (ms, so the hook was
 *     killed at once), becomes GEMINI_HOOK_TIMEOUT_MS.
 *   - OpenCode: our generated plugin, when it is an older generation, is regenerated
 *     with the launcher it already names.
 * Never throws; returns what it changed, for the proxy's log.
 */
export function healHookEntries(home?: string): string[] {
  const healed: string[] = [];
  try {
    const gp = geminiSettingsPath(home);
    const text = existsSync(gp) ? readFileSync(gp, "utf8") : null;
    const ours = text ? ourHookCommand(text, "SessionStart") : null;
    // Only a timeout that cannot possibly be milliseconds-as-meant (under a second): one
    // somebody tuned on purpose is theirs.
    if (text && ours && geminiTimeoutTooShort(text)) {
      const merged = mergeClaudeHook(text, ours, { event: "SessionStart", marker: HOOK_MARKER, matcher: "", timeout: GEMINI_HOOK_TIMEOUT_MS });
      if (merged && merged.outcome === "updated") {
        writeAtomic(gp, merged.text);
        healed.push("gemini hook timeout");
      }
    }
  } catch {
    /* best effort */
  }
  try {
    const op = openCodePluginPath(home);
    const src = existsSync(op) ? readFileSync(op, "utf8") : null;
    if (src && src.startsWith("// Generated by `retasc setup`") && !src.includes(OPENCODE_PLUGIN_GENERATION)) {
      const cmd = /^const CMD = (.*)$/m.exec(src)?.[1];
      const args = /^const ARGS = (.*)$/m.exec(src)?.[1];
      const command = cmd ? JSON.parse(cmd) : null;
      const argv: unknown = args ? JSON.parse(args) : null;
      const tail = [...HOOK_MARKER.split(" "), "--harness", "opencode"];
      if (typeof command === "string" && Array.isArray(argv) && argv.every((a) => typeof a === "string") && argv.slice(-tail.length).join(" ") === tail.join(" ")) {
        writeAtomic(op, openCodePluginSource({ command, args: (argv as string[]).slice(0, -tail.length) }));
        healed.push("opencode plugin");
      }
    }
  } catch {
    /* best effort */
  }
  // RTSC-1155 — Cursor: a machine wired before the per-prompt hook existed gets it next to
  // the sessionStart entry we already have there. Add-only, and only beside our own.
  try {
    const cp = cursorHooksPath(home);
    const text = existsSync(cp) ? readFileSync(cp, "utf8") : null;
    const j = text ? JSON.parse(text) : null;
    const start = (Array.isArray(j?.hooks?.sessionStart) ? j.hooks.sessionStart : []).find(
      (e: any) => typeof e?.command === "string" && e.command.includes(HOOK_MARKER),
    );
    const hasPrompt = (Array.isArray(j?.hooks?.beforeSubmitPrompt) ? j.hooks.beforeSubmitPrompt : []).some(
      (e: any) => typeof e?.command === "string" && e.command.includes(PROMPT_HOOK_MARKER),
    );
    if (text && start && !hasPrompt) {
      const merged = mergeCursorHook(text, start.command.replace(HOOK_MARKER, PROMPT_HOOK_VERB), { event: "beforeSubmitPrompt", marker: PROMPT_HOOK_MARKER });
      if (merged && merged.outcome === "added") {
        writeAtomic(cp, merged.text);
        healed.push("cursor prompt hook");
      }
    }
  } catch {
    /* best effort */
  }
  return healed;
}

/** Is our Gemini entry's timeout below a second, i.e. the seconds-meant 10 we used to write? */
function geminiTimeoutTooShort(text: string): boolean {
  try {
    for (const entry of JSON.parse(text)?.hooks?.SessionStart ?? []) {
      for (const h of entry?.hooks ?? []) {
        if (typeof h?.command === "string" && h.command.includes(HOOK_MARKER)) {
          return typeof h.timeout !== "number" || h.timeout < 1000;
        }
      }
    }
  } catch {
    /* unreadable: nothing to heal */
  }
  return false;
}

/** The command of our own hook entry under `event`, or null. */
function ourHookCommand(text: string, event: string): string | null {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  for (const entry of Array.isArray(j?.hooks?.[event]) ? j.hooks[event] : []) {
    for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (typeof h?.command === "string" && h.command.includes(HOOK_MARKER)) return h.command;
    }
  }
  return null;
}

/** Marks the plugin generation that reports every session (RTSC-1154), so an older one is
 *  recognised and regenerated. */
const OPENCODE_PLUGIN_GENERATION = "retasc-opencode-plugin v2";

/**
 * RTSC-1154 — is this "Claude Code" SessionStart hook actually running inside another
 * harness? Cursor and Grok both load `~/.claude/settings.json` hooks by default
 * (cursor.com/docs/reference/third-party-hooks: "The setting is on by default"; Grok's
 * hooks guide lists it as "Always"), so our Claude hook also fires there, and would file
 * that session under Claude Code. Recognised from what only those harnesses send: Cursor's
 * `cursor_version` and Grok's camelCase `hookEventName`.
 */
export function foreignToClaudeHook(stdin: string): boolean {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return false;
  }
  if (!j || typeof j !== "object") return false;
  // Only fields that name the OTHER harness. Generic ones (`workspace_roots`,
  // `workspaceRoot`) are names Claude Code could adopt itself one day, and matching them
  // would silence every real Claude Code session without a sound. Grok's payload always
  // carries camelCase `hookEventName` (its hooks guide: "Every event carries the same
  // common fields: hookEventName, sessionId, …"), so no environment check is needed.
  return "cursor_version" in j || "hookEventName" in j;
}

/**
 * Parse a `PostModelSwitch` payload (RTSC-821): `to_model` is the model from now on.
 * `cwd` is the folder, as with SessionStart. `session_id` is present but deliberately
 * NOT used to re-key the record: the switch updates the record for THIS folder in
 * place, and re-arming it is exactly what must not happen (see `updateHookRecordModel`).
 */
export function parseClaudeModelSwitchInput(stdin: string): { model: string; cwd: string; sessionId?: string } | null {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return null;
  }
  const model = ident(j?.to_model, 60);
  if (!model) return null;
  return {
    model,
    cwd: typeof j?.cwd === "string" && j.cwd ? j.cwd : process.cwd(),
    ...(ident(j?.session_id, 200) ? { sessionId: ident(j.session_id, 200)! } : {}),
  };
}

// --- wiring the Claude Code hook ---------------------------------------------------

export const HOOK_MARKER = "hook session-start";
/** RTSC-1150 — the SessionStart sources our Claude Code hook runs on. `clear` joined
 *  `startup|resume` because a /clear is a new conversation in the same process. */
export const CLAUDE_SESSION_START_MATCHER = "startup|resume|clear";
/** What `retasc setup` wrote before RTSC-1150. An entry still carrying exactly this is
 *  ours and is widened, by `setup` and by the hook itself (`healClaudeHookMatcher`). */
export const LEGACY_CLAUDE_SESSION_START_MATCHER = "startup|resume";
/** RTSC-821 — the second hook. It must be a marker `HOOK_MARKER` cannot match and that
 *  cannot match `HOOK_MARKER`, or idempotence would see one entry as the other and
 *  rewrite a SessionStart hook into a model-switch one on the next `retasc setup`.
 *  "hook session-start" and "hook model-switch" share no substring, which is the
 *  property being relied on; a future third hook must keep it. */
export const MODEL_HOOK_MARKER = "hook model-switch";

/** A shell word: bare when it is plainly one, single-quoted otherwise. Claude Code runs
 *  hook commands through a shell, and an absolute launcher path can carry a space
 *  (`/Users/John Doe/...`); unquoted, the hook would fail on every session start and
 *  nothing would name the cause. */
export function shellWord(part: string): string {
  return /^[A-Za-z0-9_.\/@:=+%,-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`;
}

/** The command the hook runs: the same launcher the MCP marker names, so an `npx`
 *  install and a global one both resolve. The marker verb stays bare, so idempotence
 *  can find the entry by it. */
export function claudeHookCommand(launcher: { command: string; args: string[] }, marker: string = HOOK_MARKER): string {
  return [...[launcher.command, ...launcher.args].map(shellWord), marker].join(" ");
}

type Settings = { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>> } & Record<string, unknown>;

/**
 * Merge our SessionStart hook into a Claude Code `settings.json` text, and say what
 * happened. Idempotent: an entry already carrying our marker is updated in place if
 * its command changed (a moved launcher), left alone if not, never duplicated. Every
 * other hook, and every other setting, survives untouched. Returns null when the file
 * is not JSON we can read, rather than replacing something we cannot parse.
 */
export function mergeClaudeHook(
  text: string | null,
  command: string,
  opts: { event?: string; marker?: string; matcher?: string; timeout?: number } = {},
): { text: string; outcome: "added" | "updated" | "unchanged" } | null {
  const event = opts.event ?? "SessionStart";
  // Seconds in Claude Code and Codex. RTSC-1154 — Gemini reads the same field in
  // MILLISECONDS, so its caller passes 10000; the 10 we used to write there killed the
  // hook after 10 ms, every time.
  const timeout = opts.timeout ?? 10;
  const marker = opts.marker ?? HOOK_MARKER;
  // SessionStart is matched on the session's SOURCE; PostModelSwitch has no source to
  // match, and an empty matcher there means every switch (RTSC-821).
  const matcher = opts.matcher ?? CLAUDE_SESSION_START_MATCHER;
  let settings: Settings = {};
  if (text && text.trim()) {
    try {
      settings = JSON.parse(text) as Settings;
    } catch {
      return null;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  }
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as NonNullable<Settings["hooks"]>;
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  let outcome: "added" | "updated" | "unchanged" = "unchanged";
  let found = false;
  for (const entry of list) {
    // Someone else's entries may be any shape; only walk the ones shaped like hooks.
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && typeof h === "object" && h.type === "command" && typeof h.command === "string" && h.command.includes(marker)) {
        found = true;
        if (h.command !== command) {
          h.command = command;
          outcome = "updated";
        }
        // RTSC-1154 — an entry of ours with the wrong timeout is corrected. Only when the
        // caller names one: Claude Code's entries keep whatever timeout they carry.
        if (opts.timeout !== undefined && (h as { timeout?: unknown }).timeout !== opts.timeout) {
          (h as { timeout?: number }).timeout = opts.timeout;
          outcome = "updated";
        }
        // RTSC-1150 — an entry we wrote with the old default is widened to the new one.
        // Only the exact old string: a matcher someone chose by hand is theirs.
        if (opts.matcher === undefined && entry.matcher === LEGACY_CLAUDE_SESSION_START_MATCHER) {
          entry.matcher = matcher;
          outcome = "updated";
        }
      }
    }
  }
  if (!found) {
    // Not `compact`: a compaction re-fires SessionStart with the SAME id and would
    // re-arm the record for a session already served. `clear` is a NEW id (RTSC-1150,
    // measured: a /clear on 2.1.282 started a fresh transcript under a fresh id), and the
    // conversation it starts has to be told which claims the window still holds.
    // `timeout` in seconds: a hook that hangs (a cold npx offline) must never hold a
    // session start.
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] });
    outcome = "added";
  }
  hooks[event] = list;
  settings.hooks = hooks;
  return { text: JSON.stringify(settings, null, 2) + "\n", outcome };
}

/**
 * The launcher the hook may name. The MCP marker's launcher is whatever `retasc` is on
 * PATH, at whatever version; a 1.39 binary has no `hook` verb and would print "unknown
 * command" on every session start, everywhere. So the hook gets that launcher only if it
 * actually answers the verb, and npx `@latest` otherwise (RTSC-1153: the newest release
 * always has the verb, and it keeps itself current where a pin would not).
 */
export function hookLauncher(
  launcher: { command: string; args: string[] },
  _version: string,
  probe: (cmd: string, args: string[]) => boolean = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, shell: process.platform === "win32" });
      return !r.error && r.status === 0;
    } catch {
      return false;
    }
  },
): { command: string; args: string[] } {
  if (launcher.command === "npx") return launcher; // `@latest`, or a pin: both have the verb
  if (probe(launcher.command, [...launcher.args, ...HOOK_MARKER.split(" "), "--help"])) return launcher;
  return { command: "npx", args: ["-y", "@retasc/cli@latest"] };
}

/** `~/.claude/settings.json`, under the same home override the harness registry honours. */
export function claudeSettingsPath(home = process.env.RETASC_HOME || homedir()): string {
  return join(home, ".claude", "settings.json");
}

/**
 * Wire the hook on this machine. Returns what it did, or why it could not. The file
 * is user-owned config Claude Code reads at start (unlike `~/.claude.json`, which a
 * running Claude Code rewrites and which is only ever edited through `claude mcp`).
 */
export function wireClaudeHook(
  launcher: { command: string; args: string[] },
  home?: string,
): { ok: true; path: string; outcome: "added" | "updated" | "unchanged" } | { ok: false; reason: string } {
  const path = claudeSettingsPath(home);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const start = mergeClaudeHook(before, claudeHookCommand(launcher));
  if (!start) return { ok: false, reason: `${path} is not JSON I can read; add the hook by hand` };
  // RTSC-821 — the model-switch hook is merged into the SAME text, so one write lands
  // both and a failure between them cannot leave a half-wired machine.
  const both = mergeClaudeHook(start.text, claudeHookCommand(launcher, MODEL_HOOK_MARKER), {
    event: "PostModelSwitch",
    marker: MODEL_HOOK_MARKER,
    matcher: "",
  });
  if (!both) return { ok: false, reason: `${path} is not JSON I can read; add the hook by hand` };
  // Either hook changing is a change worth writing; "unchanged" only when both agree.
  const outcome = start.outcome !== "unchanged" ? start.outcome : both.outcome;
  if (outcome !== "unchanged") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, both.text);
  }
  return { ok: true, path, outcome };
}

/**
 * RTSC-1150 — widen OUR SessionStart entry from the pre-1150 matcher, and touch nothing
 * else. Returns the new text, or null when there is nothing to change (or nothing we can
 * read). Separate from `mergeClaudeHook` because the hook calling it does not know the
 * launcher `setup` wired, and must not rewrite a command it did not choose.
 */
export function widenClaudeHookMatcher(text: string | null): string | null {
  if (!text || !text.trim()) return null;
  let settings: Settings;
  try {
    settings = JSON.parse(text) as Settings;
  } catch {
    return null;
  }
  const list = settings?.hooks?.SessionStart;
  if (!Array.isArray(list)) return null;
  let changed = false;
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) continue;
    if (entry.matcher !== LEGACY_CLAUDE_SESSION_START_MATCHER) continue;
    const ours = entry.hooks.some((h) => h && typeof h === "object" && typeof h.command === "string" && h.command.includes(HOOK_MARKER));
    if (!ours) continue;
    entry.matcher = CLAUDE_SESSION_START_MATCHER;
    changed = true;
  }
  return changed ? JSON.stringify(settings, null, 2) + "\n" : null;
}

/**
 * Run by the hook itself, so a machine wired before RTSC-1150 starts hearing about
 * /clear without anyone re-running `retasc setup`: the first session start after the CLI
 * updates widens the matcher, and from the next start (Claude Code reads its hooks when a
 * session starts) every /clear gets the held-claims notice. A no-op from then on. Never
 * throws.
 */
export function healClaudeHookMatcher(home?: string): boolean {
  try {
    const path = claudeSettingsPath(home);
    if (!existsSync(path)) return false;
    // Through a symlink (a dotfiles repo) to the file it names, so the link survives.
    const real = realpathSync(path);
    const next = widenClaudeHookMatcher(readFileSync(real, "utf8"));
    if (!next) return false;
    // Aside and renamed in: this runs unasked from every session start, several windows
    // can start at once, and a Claude Code that read a half-written settings file would
    // start without the user's permission rules. Their file mode is kept.
    const tmp = `${real}.retasc-${process.pid}.tmp`;
    writeFileSync(tmp, next, { mode: statSync(real).mode & 0o777 });
    renameSync(tmp, real);
    return true;
  } catch {
    return false;
  }
}

// =====================================================================================
// RTSC-822 — the other harnesses.
//
// Every payload below was CAPTURED from a live run on 2026-09-20, not read from a
// vendor doc. The docs this issue was written from were wrong about Codex twice and
// about Cursor once, so the shapes here are what the binaries actually emit:
// `codex-cli 0.154.0`, `cursor-agent 2026.09.02-c22c1a3`, `opencode 1.18.29`.
// Gemini is the exception and says so at its own parser.
//
// Two fields in these payloads must NEVER reach a record: Cursor sends `user_email`
// and Codex sends the user's literal `prompt`. Neither is read below, and a test
// asserts they stay out — RTSC-791 keeps a USERNAME off the wire, and these are worse.
// =====================================================================================

/** What every harness's SessionStart-equivalent boils down to. */
export type ParsedHook = { sessionId: string; cwd: string; model?: string; transcriptPath?: string };

/**
 * Codex `UserPromptSubmit` (codex-cli 0.154.0).
 *
 * Not SessionStart, although Codex 0.154.0 has one (RTSC-1154 corrected the claim that
 * it did not; wiring it is RTSC-1155's). UserPromptSubmit fires on the first prompt,
 * which is later than a session start but still lands inside the proxy's pickup window: `at` is compared against the
 * proxy's own start and a record written AFTER it is accepted.
 *
 * Captured payload:
 *   {"session_id","turn_id","transcript_path","cwd","hook_event_name","model",
 *    "permission_mode","prompt"}
 *
 * `prompt` is the user's literal text and is deliberately not read.
 */
export function parseCodexHookInput(stdin: string): ParsedHook | null {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return null;
  }
  const sessionId = ident(j?.session_id, 200);
  if (!sessionId) return null;
  const cwd = typeof j?.cwd === "string" && j.cwd ? j.cwd : process.cwd();
  return {
    sessionId,
    cwd,
    ...(ident(j?.model, 60) ? { model: ident(j.model, 60)! } : {}),
    ...(typeof j?.transcript_path === "string" && j.transcript_path ? { transcriptPath: j.transcript_path } : {}),
  };
}

/**
 * Cursor `sessionStart` (cursor-agent 2026.09.02-c22c1a3).
 *
 * `cursor-agent`, never `cursor` — the latter is the IDE launcher and has no hooks at
 * all (`harness.ts` already refuses to detect on it).
 *
 * Captured payload:
 *   {"conversation_id","generation_id","model","is_background_agent","session_id",
 *    "hook_event_name","cursor_version","workspace_roots","user_email","transcript_path"}
 *
 * TWO DIFFERENCES that bite:
 *
 * 1. THERE IS NO `cwd`. The folder arrives as `workspace_roots[0]`, and the folder is
 *    what keys the whole meeting-point design — a parser that looks for `cwd` here
 *    silently records every session against the process's own directory instead.
 * 2. `user_email` IS IN THE PAYLOAD and is never read. A path bakes in a username
 *    (RTSC-791); an address is the person.
 *
 * `session_id` and `conversation_id` held the same value in the captured run. The id is
 * read from `session_id` first and `conversation_id` second, because the issue records
 * `conversation_id` arriving blank on some events (Cursor forum #167095) — and a blank
 * one yields no record rather than an empty one.
 *
 * `transcript_path` was `null` and `model` was `"unknown"` under `-p`; both are optional
 * here, so that is a record carrying less, never a failed parse.
 */
export function parseCursorHookInput(stdin: string): ParsedHook | null {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return null;
  }
  const sessionId = ident(j?.session_id, 200) ?? ident(j?.conversation_id, 200);
  if (!sessionId) return null;
  const roots = Array.isArray(j?.workspace_roots) ? j.workspace_roots : [];
  const root = roots.find((r: unknown) => typeof r === "string" && r);
  const cwd = typeof root === "string" && root ? root : process.cwd();
  // "unknown" is Cursor's own placeholder under -p, not a model anyone chose.
  const model = ident(j?.model, 60);
  return {
    sessionId,
    cwd,
    ...(model && model !== "unknown" ? { model } : {}),
    ...(typeof j?.transcript_path === "string" && j.transcript_path ? { transcriptPath: j.transcript_path } : {}),
  };
}

/**
 * Gemini CLI `SessionStart` (gemini 0.59.0).
 *
 * ⚠ NEVER OBSERVED RUNNING. Every other parser in this file was built from a captured
 * payload; this one was not. A live run needs `GEMINI_API_KEY` (this machine's
 * `security.auth.selectedType` is `gemini-api-key` and the env had none), so Gemini
 * refuses to start a session and the hook never fires.
 *
 * What IS verified: `SessionStart` exists in the installed bundle alongside SessionEnd,
 * PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop and PreCompact, and the
 * strings `session_id`, `transcript_path`, `hook_event_name` and `cwd` are all present
 * in it. Gemini also ships `gemini hooks migrate` — "Migrate hooks from Claude Code to
 * Gemini CLI" — which is why Claude Code's field names are assumed here.
 *
 * So this is a best guess from the binary, and if the real payload differs it records
 * NOTHING rather than something wrong. Confirm against a real session before trusting
 * a Gemini row on the Agents page.
 */
export function parseGeminiHookInput(stdin: string): ParsedHook | null {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return null;
  }
  const sessionId = ident(j?.session_id, 200);
  if (!sessionId) return null;
  return {
    sessionId,
    cwd: typeof j?.cwd === "string" && j.cwd ? j.cwd : process.cwd(),
    ...(ident(j?.model, 60) ? { model: ident(j.model, 60)! } : {}),
    ...(typeof j?.transcript_path === "string" && j.transcript_path ? { transcriptPath: j.transcript_path } : {}),
  };
}

/** Every harness whose payload `retasc hook session-start` can read. */
export const HOOK_PARSERS: Record<string, (stdin: string) => ParsedHook | null> = {
  "claude-code": parseClaudeHookInput,
  codex: parseCodexHookInput,
  cursor: parseCursorHookInput,
  gemini: parseGeminiHookInput,
  opencode: parseOpenCodeHookInput,
};

// --- wiring, one shape per harness --------------------------------------------------

/** Codex's hooks file. Its schema IS Claude Code's, so `mergeClaudeHook` does the work —
 *  the issue's plan said this needed `spliceTomlTable` against `config.toml`, and that is
 *  wrong: `config.toml` holds hook TRUST, `hooks.json` holds the hooks. */
export function codexHooksPath(home = process.env.RETASC_HOME || homedir()): string {
  return join(home, ".codex", "hooks.json");
}

/** Gemini reads hooks from its own settings file, in Claude Code's shape. */
export function geminiSettingsPath(home = process.env.RETASC_HOME || homedir()): string {
  return join(home, ".gemini", "settings.json");
}

/** Cursor's hooks file — `~/.cursor/hooks.json`, read by `cursor-agent`. */
export function cursorHooksPath(home = process.env.RETASC_HOME || homedir()): string {
  return join(home, ".cursor", "hooks.json");
}

/**
 * Merge our hook into a CURSOR hooks file. A separate merger because Cursor's schema is
 * NOT Claude's: entries are flat `{command}` objects under the event, with no `matcher`
 * and no `type`, and the file carries a top-level `version`.
 *
 *   {"version":1,"hooks":{"sessionStart":[{"command":"…"}]}}
 *
 * Idempotent on the marker, exactly as `mergeClaudeHook` is: an entry already carrying
 * it is updated in place if the command moved, left alone if not, never duplicated.
 * Returns null when the file is not JSON we can read, rather than replacing it.
 */
export function mergeCursorHook(
  text: string | null,
  command: string,
  opts: { event?: string; marker?: string } = {},
): { text: string; outcome: "added" | "updated" | "unchanged" } | null {
  const event = opts.event ?? "sessionStart";
  const marker = opts.marker ?? HOOK_MARKER;
  let cfg: { version?: unknown; hooks?: Record<string, Array<{ command?: unknown }>> } & Record<string, unknown> = {};
  if (text && text.trim()) {
    try {
      cfg = JSON.parse(text);
    } catch {
      return null;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  }
  const hooks = (cfg.hooks && typeof cfg.hooks === "object" && !Array.isArray(cfg.hooks) ? cfg.hooks : {}) as Record<
    string,
    Array<{ command?: unknown }>
  >;
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  let outcome: "added" | "updated" | "unchanged" = "unchanged";
  let found = false;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string" && entry.command.includes(marker)) {
      found = true;
      if (entry.command !== command) {
        entry.command = command;
        outcome = "updated";
      }
    }
  }
  if (!found) {
    list.push({ command });
    outcome = "added";
  }
  hooks[event] = list;
  cfg.hooks = hooks;
  // Cursor's own files carry `version: 1`; set it only when absent so a future version
  // written by Cursor itself is never downgraded by us.
  if (cfg.version === undefined) cfg.version = 1;
  return { text: JSON.stringify(cfg, null, 2) + "\n", outcome };
}

/** The shared write step: merge, and only touch the file when something changed. */
function wireWith(
  path: string,
  merge: (text: string | null) => { text: string; outcome: "added" | "updated" | "unchanged" } | null,
): { ok: true; path: string; outcome: "added" | "updated" | "unchanged" } | { ok: false; reason: string } {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const merged = merge(before);
  if (!merged) return { ok: false, reason: `${path} is not JSON I can read; add the hook by hand` };
  if (merged.outcome !== "unchanged") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, merged.text);
  }
  return { ok: true, path, outcome: merged.outcome };
}

/**
 * Codex. Wired on `UserPromptSubmit`, which fires on the first prompt. (RTSC-1154: this
 * used to say Codex has no SessionStart. 0.154.0 has one, with source `startup`,
 * `resume`, `clear` or `compact` per learn.chatgpt.com/docs/hooks. Wiring it is
 * RTSC-1155's, where the clear/resume notice needs it and where it can be verified live:
 * a new entry is untrusted until the user reviews it in `/hooks`.)
 *
 * ⚠ WIRING IS NOT ENOUGH, and this function cannot fix that. Codex gates hooks behind a
 * TRUST record in `~/.codex/config.toml`:
 *
 *   [hooks.state."<hooks.json path>:user_prompt_submit:0:0"]
 *   trusted_hash = "sha256:…"
 *
 * Measured both ways on 2026-09-20: with `--dangerously-bypass-hook-trust` a freshly
 * written hook fires; without it the same hook is silently skipped while Codex's
 * already-trusted hooks run. We deliberately do NOT write that hash — marking our own
 * hook trusted on the user's behalf is bypassing a gate Codex put there on purpose.
 * `retasc setup` says so instead, so nobody is told a hook is working when it is not.
 */
export function wireCodexHook(
  launcher: { command: string; args: string[] },
  home?: string,
): { ok: true; path: string; outcome: "added" | "updated" | "unchanged" } | { ok: false; reason: string } {
  const cmd = claudeHookCommand(launcher, HOOK_MARKER) + " --harness codex";
  return wireWith(codexHooksPath(home), (t) =>
    mergeClaudeHook(t, cmd, { event: "UserPromptSubmit", marker: HOOK_MARKER, matcher: ".*" }),
  );
}

/** Gemini. Claude Code's schema, its own settings file, but `timeout` in MILLISECONDS
 *  (geminicli.com/docs/hooks/reference: "Execution timeout in milliseconds"). RTSC-1154 —
 *  until this it was written as 10, so Gemini killed the hook after 10 ms and it never
 *  recorded anything; an existing entry is corrected here and by `healHookEntries`. */
export const GEMINI_HOOK_TIMEOUT_MS = 10_000;

export function wireGeminiHook(
  launcher: { command: string; args: string[] },
  home?: string,
): { ok: true; path: string; outcome: "added" | "updated" | "unchanged" } | { ok: false; reason: string } {
  const cmd = claudeHookCommand(launcher, HOOK_MARKER) + " --harness gemini";
  return wireWith(geminiSettingsPath(home), (t) =>
    mergeClaudeHook(t, cmd, { event: "SessionStart", marker: HOOK_MARKER, matcher: "", timeout: GEMINI_HOOK_TIMEOUT_MS }),
  );
}

/** Cursor. Its own flat schema, on the real `sessionStart` event, and (RTSC-1155) on
 *  `beforeSubmitPrompt`, which is where a conversation begun by /clear or /resume first
 *  appears. That one must answer JSON (`{"continue":true}`); `hook prompt` does. */
export function wireCursorHook(
  launcher: { command: string; args: string[] },
  home?: string,
): { ok: true; path: string; outcome: "added" | "updated" | "unchanged" } | { ok: false; reason: string } {
  const cmd = claudeHookCommand(launcher, HOOK_MARKER) + " --harness cursor";
  const promptCmd = claudeHookCommand(launcher, PROMPT_HOOK_VERB) + " --harness cursor";
  return wireWith(cursorHooksPath(home), (t) => {
    const start = mergeCursorHook(t, cmd);
    if (!start) return null;
    const prompt = mergeCursorHook(start.text, promptCmd, { event: "beforeSubmitPrompt", marker: PROMPT_HOOK_MARKER });
    if (!prompt) return null;
    const outcome = start.outcome === "added" || prompt.outcome === "added" ? "added" : start.outcome === "updated" || prompt.outcome === "updated" ? "updated" : "unchanged";
    return { text: prompt.text, outcome };
  });
}

// --- OpenCode: a plugin, not a hook -------------------------------------------------

/** Where OpenCode loads plugins from. ESM, one file, loaded at startup. */
export function openCodePluginPath(home = process.env.RETASC_HOME || homedir()): string {
  return join(home, ".config", "opencode", "plugins", "retasc-session.js");
}

/**
 * The plugin OpenCode loads. It does NOT write a record itself — it shells out to
 * `retasc hook session-start --harness opencode` with the same JSON shape every other
 * harness sends, so the record's format, its TTL sweep, its binding check and its
 * redaction all stay in ONE place instead of being reimplemented in a file we generate.
 *
 * Verified live on opencode 1.18.29: `session.created` carries
 * `{sessionID: "ses_…", info: {directory, …}}`, and the plugin factory itself receives
 * `{directory, worktree, client, project, serverUrl, $}`. `info.model` is NOT on
 * `created` — it first appears on `session.updated` — so the model is simply absent
 * here rather than waited for; the id is what makes the record worth writing.
 *
 * Fail-open throughout: a plugin that throws must never break the session it observes.
 */
export function openCodePluginSource(launcher: { command: string; args: string[] }): string {
  const argv = JSON.stringify([...launcher.args, ...HOOK_MARKER.split(" "), "--harness", "opencode"]);
  return `// Generated by \`retasc setup\` (RTSC-822). Safe to delete; setup rewrites it.
// ${OPENCODE_PLUGIN_GENERATION}
//
// Reports this OpenCode session's id to the Retasc proxy by handing it to the same CLI
// verb every other harness's hook calls, so nothing about the record format lives here.
import { spawn } from "node:child_process"

const CMD = ${JSON.stringify(launcher.command)}
const ARGS = ${argv}

function report(sessionId, cwd) {
  try {
    const p = spawn(CMD, ARGS, { stdio: ["pipe", "ignore", "ignore"], detached: false })
    p.on("error", () => {})
    p.stdin.on("error", () => {})
    p.stdin.end(JSON.stringify({ session_id: sessionId, cwd }))
  } catch {
    // fail-open: never break the session
  }
}

// RTSC-1154 — EVERY top-level session, not only the first one this process saw: after
// /new, OpenCode creates a new session (on its first prompt), and that one is the window's
// conversation now. A child session (a subagent, \`info.parentID\` set) is never the window's.
const RetascSession = async ({ directory }) => {
  const seen = new Set()
  return {
    event: async ({ event }) => {
      try {
        if (!event || event.type !== "session.created") return
        const props = event.properties || {}
        const info = props.info || {}
        if (info.parentID) return
        const id = props.sessionID || info.id
        const cwd = info.directory || directory
        if (!id || !cwd || seen.has(id)) return
        seen.add(id)
        report(id, cwd)
      } catch {
        // fail-open
      }
    },
  }
}

export default RetascSession
`;
}

/**
 * OpenCode's payload, as OUR generated plugin sends it. Deliberately the same field
 * names the harness hooks use, so this is the Claude shape minus what a plugin cannot
 * know at `session.created`.
 */
export function parseOpenCodeHookInput(stdin: string): ParsedHook | null {
  let j: any;
  try {
    j = JSON.parse(stdin);
  } catch {
    return null;
  }
  const sessionId = ident(j?.session_id, 200);
  if (!sessionId) return null;
  return { sessionId, cwd: typeof j?.cwd === "string" && j.cwd ? j.cwd : process.cwd() };
}

/** Write the plugin. Rewritten whenever its contents differ, so a moved launcher is
 *  picked up on the next `retasc setup`, and left alone when identical. */
export function wireOpenCodePlugin(
  launcher: { command: string; args: string[] },
  home?: string,
): { ok: true; path: string; outcome: "added" | "updated" | "unchanged" } | { ok: false; reason: string } {
  const path = openCodePluginPath(home);
  const want = openCodePluginSource(launcher);
  try {
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (before === want) return { ok: true, path, outcome: "unchanged" };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
    return { ok: true, path, outcome: before === null ? "added" : "updated" };
  } catch (e) {
    return { ok: false, reason: String((e as any)?.message ?? e) };
  }
}
