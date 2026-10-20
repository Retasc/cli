// RTSC-1153 — the CLI keeps itself current, so nobody has to.
//
// Until this, every path that starts the CLI stayed on the old build until a human acted:
// the global `retasc` (what `bind` installs and every harness entry names) until someone
// ran `npm i -g` or `retasc update`, and a pinned npx marker forever. The only automatic
// thing was a notice, which reached the human only if an agent relayed it. RTSC-520 chose
// that on purpose ("notify, then ask, never a silent install"), and every fix after it
// (861, 869, 1091, 1092, 1127) could only make the notice better, never remove the step.
//
// The founder reversed it on 2026-09-28: updates are automatic, ON by default, the human
// is told once, and `retasc config auto-update off` turns it off. What is kept from 520 is
// everything that made a silent install dangerous, each handled here rather than by asking:
//   - Never mid-session. The proxy starts the update in a DETACHED child and carries on;
//     the running session keeps its build and the next one starts the new build. Safe to
//     swap the files under a running proxy because it loads its whole module graph at
//     startup (the only lazy imports are in `bind` and `import`).
//   - A root-owned prefix (EACCES) is not an error anyone sees mid-work: it is RECORDED,
//     the proxy reports it on its next start, and the server's stale-CLI notice speaks.
//   - Never in CI, where a build that changes under a pipeline is a flake nobody can trace.
//   - At most once a day per machine, decided under the config lock so several sessions
//     starting together start one update, not several.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { clean } from "./text.js";
import { loadConfig, updateConfigIf, type Config } from "../config.js";
import { compareVersions } from "./updateNotice.js";

/** How often a machine asks npm whether there is something newer. */
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** After a check that could not reach npm, try again this soon rather than tomorrow. */
export const AUTO_UPDATE_RETRY_MS = 60 * 60 * 1000;

/** No completed check for this long, and the machine counts as not keeping itself
 *  current: the proxy reports `failed` and the server's notice speaks again. */
export const AUTO_UPDATE_STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** `RETASC_AUTO_UPDATE=0` (or off/false/no) forces it off, whatever the config says. */
export const AUTO_UPDATE_ENV = "RETASC_AUTO_UPDATE";

export type AutoUpdateState = { enabled: true } | { enabled: false; why: "env" | "ci" | "config" };

/** A CI run: the conventional variable, and the one GitHub sets for certain. */
export function isCI(env: NodeJS.ProcessEnv): boolean {
  const ci = (env.CI ?? "").trim().toLowerCase();
  return (ci !== "" && ci !== "0" && ci !== "false") || Boolean(env.GITHUB_ACTIONS) || Boolean(env.CONTINUOUS_INTEGRATION);
}

export function autoUpdateState(env: NodeJS.ProcessEnv, cfg: Pick<Config, "autoUpdate">): AutoUpdateState {
  const flag = (env[AUTO_UPDATE_ENV] ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(flag)) return { enabled: false, why: "env" };
  if (isCI(env)) return { enabled: false, why: "ci" };
  // Absent is ON. Only an explicit `false` from `retasc config auto-update off` is off.
  if (cfg.autoUpdate === false) return { enabled: false, why: "config" };
  return { enabled: true };
}

/** Has a day passed since the last start? A stamp in the future (a clock that moved
 *  back) counts as due, or a machine could stop updating until the clock caught up. */
export function dueForAttempt(now: number, lastAt: number | undefined): boolean {
  if (lastAt === undefined || lastAt > now) return true;
  return now - lastAt >= AUTO_UPDATE_INTERVAL_MS;
}

export type AutoUpdateStart = "started" | "disabled" | "throttled" | "failed-to-start";

/**
 * The proxy's half: start one background update if it is time. Never throws, never
 * waits: the session must not notice. Whether this build is actually behind is the
 * CHILD's question (`update --auto` asks npm), so the proxy costs nothing on the hot
 * path and needs no network of its own.
 */
export function maybeStartAutoUpdate(deps: {
  env: NodeJS.ProcessEnv;
  now: number;
  /** Stamp `autoUpdateAt` if and only if it is due, atomically. True when stamped. */
  claimSlot: (now: number) => boolean;
  config: () => Pick<Config, "autoUpdate">;
  spawnUpdate: () => void;
}): AutoUpdateStart {
  try {
    if (!autoUpdateState(deps.env, deps.config()).enabled) return "disabled";
    if (!deps.claimSlot(deps.now)) return "throttled";
    deps.spawnUpdate();
    return "started";
  } catch {
    return "failed-to-start";
  }
}

/** The real `claimSlot`: check-and-stamp under the config lock. A plain read first, so
 *  the ordinary not-due start never touches the lock on the proxy's startup path. */
export function claimAutoUpdateSlot(now: number): boolean {
  if (!dueForAttempt(now, loadConfig().autoUpdateAt)) return false;
  return updateConfigIf((cfg) =>
    dueForAttempt(now, cfg.autoUpdateAt)
      ? { autoUpdateAt: now, ...(cfg.autoUpdatePendingSince === undefined ? { autoUpdatePendingSince: now } : {}) }
      : null,
  );
}

/** The real `spawnUpdate`: this same CLI, detached, with nothing attached to the
 *  harness's stdio (stdout is the MCP protocol channel).
 *
 *  From the HOME directory, never the proxy's cwd. The proxy runs in a project folder,
 *  and `npm view` / `npx` honour a project `.npmrc`: a committed `registry=` line would
 *  otherwise choose which code this machine installs and runs, unasked. */
export function spawnDetachedUpdate(entry: string, from: string): void {
  const child = spawn(process.execPath, [entry, "update", "--auto"], {
    cwd: homedir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, [UPDATE_FROM_ENV]: from },
  });
  child.on("error", () => {
    /* recorded nowhere: the next day's attempt is the retry */
  });
  child.unref();
}

/** The version a background update started from, carried through the npx hand-over so
 *  the build that finishes the job can record where it came from. */
export const UPDATE_FROM_ENV = "RETASC_UPDATE_FROM";

/**
 * What the proxy tells the server about this machine, on `mint_session_key`.
 *
 * `failed` is the one that matters: it hands the job back to the server's stale-CLI
 * notice, which otherwise stays quiet for a machine that updates itself. "On" has to be
 * EARNED, because the server believes it: a machine that says "on" and never updates is
 * never warned again. Three ways to `failed`:
 *   - the last update failed outright;
 *   - it succeeded and this proxy STILL started on an older build, so whatever launched it
 *     is not following the update (a pinned marker committed to a repo, which the
 *     background update never rewrites);
 *   - no check has completed for three days since they began: npm unreachable from the
 *     harness's environment, a child that dies, a spawn that fails. Silence is not success.
 */
export function reportedStatus(
  version: string,
  state: AutoUpdateState,
  cfg: Pick<Config, "autoUpdateResult" | "autoUpdateCheckedAt" | "autoUpdatePendingSince">,
  startedAt: number,
  now: number = Date.now(),
): "on" | "off" | "failed" {
  if (!state.enabled) return "off";
  const result = cfg.autoUpdateResult;
  if (result && !result.ok) return "failed";
  if (result?.ok && result.to && result.at < startedAt && compareVersions(version, result.to) < 0) return "failed";
  if (stale(cfg, now)) return "failed";
  return "on";
}

/** The one-time notice. The same sentence wherever it is said. */
export const AUTO_UPDATE_NOTICE =
  "Retasc now updates itself in the background, and each update takes effect in your next session. " +
  "To turn that off, run retasc config auto-update off.";

/** Claim the one-time notice for this machine: true exactly once, and only while
 *  auto-update is on (telling someone who turned it off would be wrong). */
export function takeAutoUpdateNotice(env: NodeJS.ProcessEnv, now: number = Date.now()): boolean {
  try {
    const cfg = loadConfig();
    if (!autoUpdateState(env, cfg).enabled) return false;
    // Already said: the common case on every later command and session start, so it
    // costs a read, not the config lock.
    if (cfg.autoUpdateNoticeAt !== undefined) return false;
    return updateConfigIf((cfg) => (cfg.autoUpdateNoticeAt === undefined ? { autoUpdateNoticeAt: now } : null));
  } catch {
    return false;
  }
}

/**
 * RTSC-1153 — the one-time notice, on a tool result: the one channel every harness shows
 * its agent (Codex, Cursor, Gemini, Grok, OpenCode and Pi alike), where the session hook
 * reaches only Claude Code. Attached to a successful result only, and the notice is
 * claimed (stamped for the machine) only once it is actually on the response, so an
 * error envelope never spends it. True when attached.
 */
export function attachAutoUpdateNotice(resp: unknown, take: () => boolean): boolean {
  const result = (resp as any)?.result;
  if (!result || result.isError || !Array.isArray(result.content)) return false;
  if (!take()) return false;
  result.content.push({ type: "text", text: `PASS THIS TO YOUR HUMAN: ${AUTO_UPDATE_NOTICE}` });
  return true;
}

/** Checks have been started for three days and none has completed. Measured from the first
 *  unanswered attempt, not from the last success: an idle machine is not a failing one. */
function stale(cfg: Pick<Config, "autoUpdatePendingSince">, now: number): boolean {
  return cfg.autoUpdatePendingSince !== undefined && now - cfg.autoUpdatePendingSince > AUTO_UPDATE_STALE_MS;
}

/** Is anything actually keeping this machine current? What `doctor` colours its line by. */
export function autoUpdateHealthy(
  state: AutoUpdateState,
  cfg: Pick<Config, "autoUpdateResult" | "autoUpdateCheckedAt" | "autoUpdatePendingSince">,
  now: number = Date.now(),
): boolean {
  if (!state.enabled || cfg.autoUpdateResult?.ok === false) return false;
  return !stale(cfg, now);
}

/** A line for `doctor`. */
export function describeAutoUpdate(
  state: AutoUpdateState,
  cfg: Pick<Config, "autoUpdateResult" | "autoUpdateAt" | "autoUpdateCheckedAt" | "autoUpdatePendingSince">,
  now: number = Date.now(),
): string {
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  if (!state.enabled) {
    if (state.why === "env") return `auto-update is off because ${AUTO_UPDATE_ENV} is set.`;
    if (state.why === "ci") return "auto-update is off in CI.";
    return "auto-update is off. Turn it back on with retasc config auto-update on.";
  }
  const r = cfg.autoUpdateResult;
  // `clean`: the error is npm's own stderr, and the file is hand-editable.
  if (r && !r.ok) return `auto-update is on, but the last update failed on ${day(r.at)} (${clean(r.error ?? "no reason recorded")}).`;
  if (stale(cfg, now)) {
    return `auto-update is on, but it has been trying to check for a new version since ${day(cfg.autoUpdatePendingSince!)} without getting an answer.`;
  }
  if (r?.to && r.to !== r.from) return `auto-update is on. The last update went from ${clean(r.from)} to ${clean(r.to)} on ${day(r.at)}.`;
  if (cfg.autoUpdateCheckedAt) return `auto-update is on. It last checked for a new version on ${day(cfg.autoUpdateCheckedAt)}.`;
  return "auto-update is on. It checks for a new version when your next session starts.";
}
