import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { VERSION } from "../version.js";
import { globalBinCandidates, installGlobal, npmGlobalPrefix, runsOk, type Resolved } from "../lib/launcher.js";
import { findBindingByPath, loadKeystore } from "../lib/keystore.js";
import { claudeLocalRetascEntry } from "../lib/binding.js";
import { SERVER_NAME, tildePath } from "../lib/harness.js";
import { compareVersions } from "../lib/updateNotice.js";
import { clean } from "../lib/text.js";
import { loadConfig, updateConfigIf } from "../config.js";
import { AUTO_UPDATE_INTERVAL_MS, AUTO_UPDATE_RETRY_MS, UPDATE_FROM_ENV } from "../lib/autoUpdate.js";
import { runSetup, type SetupResult } from "./setup.js";

// RTSC-1127 — `retasc update`: bring every copy of Retasc this machine starts to THIS build.
//
// Before this there was no command for "I am connected, give me the new version", and the
// two the stale-CLI notice alternated between each fixed half of the machines it went to:
//
//   - `npm i -g` (until RTSC-1091) upgrades the global binary. A folder whose marker is a
//     pinned npx spec — every committed `.mcp.json` since 1.49.0 — never starts that binary,
//     so it stayed on the old build and the reader believed they had fixed it.
//   - `npx … bind` (RTSC-1091 until this) rewrites a marker, but it CONNECTS a folder. Run
//     from a fresh terminal (the home directory) it signed a connected user in again and
//     offered the org picker with "+ create new"; run in the bound folder it asked "Replace
//     it?"; and either way `resolveLauncher` leaves a working global `retasc` alone, so a
//     marker naming that binary kept starting the old one. Measured 2026-09-23.
//
// So this does exactly the upgrade and nothing else. No sign-in, no org, no prompt, and no
// dependence on the folder it is run from: the bound folders come from the keystore.
//   1. A global install, if there is one, is upgraded to this version. None is created: a
//      machine that runs us through npx is not asked to grow a global install.
//   2. The machine-wide harness entries are re-wired through `runSetup`, which is what
//      `setup` is for after an upgrade moved the launcher.
//   3. Every per-folder marker pinned to an exact version is moved to `@latest`, in
//      `./.mcp.json` and in Claude Code's local scope, so it never needs this again. Only
//      the spec argument changes; the env, and anything else in the file, is left exactly
//      as it was.
//
// The target is THIS build's version, so what it installs is the code that is running. The
// registry is asked only to decide WHETHER this build should do the work: a build behind
// latest hands over to the newest `update` (`delegateIfBehind`).
//
// RTSC-1153 — `--auto` is the same command run by the proxy in the background, once a day.
// It says nothing, skips a build that is already current, never rewrites a file git
// tracks (a background process does not leave diffs in someone's repo), and records what
// it did in the config for `doctor` and for the proxy to report.
//
// RTSC-1153 — markers move to `@latest`, not to a newer pin. RTSC-1091 pinned them on the
// premise that npx never re-resolves a tag. On npm 11 that is false: libnpmexec's
// `missingFromTree` fetches the manifest for a tag spec with `preferOnline` on every run
// and reinstalls into the same cache dir when `_resolved` moved, and falls back to the
// cached copy when the registry is unreachable (both measured 2026-09-28). A pin is what
// went stale: it named one version until a human ran this.

const PKG = "@retasc/cli";
const WIN = process.platform === "win32";

/** What every marker this command writes names. */
export const LATEST_SPEC = `${PKG}@latest`;

type McpEntry = { command?: string; args?: string[]; [k: string]: unknown };

/**
 * The same entry naming `@retasc/cli@latest`, or null when there is nothing to change.
 *
 * Only an entry PINNED to an exact version changes. Null for an entry that does not launch
 * through npx (a global `retasc` or an absolute path to it: step 1 upgrades what those
 * name), for one with no `@retasc/cli` spec (a hand-written entry we do not recognise is
 * not ours to edit), for one already on `@latest`, for a bare `@retasc/cli` (npx
 * re-resolves that too), and for another tag such as `@next` (somebody chose it).
 */
export function repin(entry: McpEntry | undefined): { entry: McpEntry; from: string } | null {
  if (!entry || entry.command !== "npx" || !Array.isArray(entry.args)) return null;
  const i = entry.args.findIndex((a) => typeof a === "string" && /^@retasc\/cli@\d+\.\d+\.\d+\S*$/.test(a.trim()));
  if (i < 0) return null;
  const from = entry.args[i].trim();
  const args = [...entry.args];
  args[i] = LATEST_SPEC;
  return { entry: { ...entry, args }, from };
}

/** Move the retasc entry in `<dir>/.mcp.json` to `@latest`. Returns what it named before,
 *  or null when the file holds no entry this changes. Throws on a file it cannot parse. */
export function repinFolderMarker(dir: string): string | null {
  const path = join(dir, ".mcp.json");
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const next = repin(doc?.mcpServers?.[SERVER_NAME]);
  if (!next) return null;
  doc.mcpServers[SERVER_NAME] = next.entry;
  // Written beside it and renamed over it, so a crash mid-write cannot leave the folder
  // with a truncated marker, and with the original's mode, so a 0600 file stays 0600. Same
  // formatting as `writeProjectMcpJson`: a file we wrote gets a one-line diff.
  const tmp = `${path}.retasc-update-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
  return next.from;
}

/**
 * Every folder this machine has bound, from the keystore: the only place that knows them
 * without being run inside one. Existing directories only, each once. `cwd` is added when it
 * carries a marker AND resolves to one of this machine's bindings (a worktree of a bound
 * repo, RTSC-862), so a teammate's committed marker in a repo never bound here is not ours
 * to rewrite.
 */
export function boundFolders(cwd: string = process.cwd()): string[] {
  const dirs = new Set<string>();
  for (const entry of Object.values(loadKeystore().bindings)) {
    if (entry?.boundPath && existsSync(entry.boundPath)) dirs.add(resolve(entry.boundPath));
  }
  if (existsSync(join(cwd, ".mcp.json")) && findBindingByPath(cwd)) dirs.add(resolve(cwd));
  return [...dirs];
}

/**
 * The global install, found by npm's prefix rather than by PATH.
 *
 * PATH cannot answer this here. Run as `npx … update`, npx puts its own cache AHEAD of the
 * global bin, so `which retasc` names the copy that is running right now (RTSC-715).
 */
export function findGlobal(): { bin: string; version: string } | null {
  const prefix = npmGlobalPrefix();
  for (const bin of prefix ? globalBinCandidates(prefix) : []) {
    if (!existsSync(bin)) continue;
    const version = runsOk(bin);
    if (version) return { bin, version };
  }
  return null;
}

/** The first `retasc` on PATH that outlives this process: npx's cache dirs are skipped. */
export function durableOnPath(pathVar: string = process.env.PATH ?? ""): string | null {
  for (const d of pathVar.split(delimiter)) {
    if (!d || /[\\/]_npx([\\/]|$)/.test(d)) continue;
    const p = join(d, WIN ? "retasc.cmd" : "retasc");
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Swap Claude Code's local-scope retasc entry for `dir`.
 *
 * Through `claude mcp`, never by editing `~/.claude.json`: a running Claude Code rewrites
 * that file constantly (see the Claude Code harness). `add-json` takes the entry whole, so
 * its env, whatever it carries, goes back exactly as it came out. `add` refuses an existing
 * name, hence the remove first, and a failed add puts the ORIGINAL back so a failure leaves
 * the folder as it was rather than with no entry at all.
 *
 * `add-json` is PROBED before anything is removed. A `claude` old enough to lack it would
 * otherwise pass the remove, fail the add, fail the restore for the same reason, and leave
 * the folder with no entry — including any key that lived only in `~/.claude.json`. And if
 * the restore fails anyway, that is said outright rather than folded into the add's error.
 */
export type ClaudeRun = (args: string[], cwd: string) => { status: number | null; error?: Error; stdout?: string; stderr?: string };

const claudeRun: ClaudeRun = (args, cwd) => spawnSync("claude", args, { cwd, encoding: "utf8" });

export function replaceClaudeLocal(dir: string, next: McpEntry, prev: McpEntry, run: ClaudeRun = claudeRun): string | null {
  const ok = (r: ReturnType<ClaudeRun>) => !r.error && r.status === 0;
  const why = (r: ReturnType<ClaudeRun>) =>
    r.error ? r.error.message : (r.stderr || r.stdout || "").trim().split("\n")[0] || `exited ${r.status}`;
  // Read the help, not the exit code: `claude mcp <unknown> --help` prints the PARENT's
  // help and exits 0, so a status check passes on a claude that has no such command.
  const probe = run(["mcp", "add-json", "--help"], dir);
  if (!ok(probe) || !/claude mcp add-json/.test(probe.stdout ?? "")) return `this Claude Code has no \`claude mcp add-json\` (${why(probe)}); left as it was. Update Claude Code, then run this again`;
  const removed = run(["mcp", "remove", SERVER_NAME, "-s", "local"], dir);
  if (!ok(removed)) return `${why(removed)}; left as it was`;
  const added = run(["mcp", "add-json", SERVER_NAME, JSON.stringify(next), "-s", "local"], dir);
  if (ok(added)) return null;
  const restored = run(["mcp", "add-json", SERVER_NAME, JSON.stringify(prev), "-s", "local"], dir);
  if (ok(restored)) return `${why(added)}; the previous entry was put back`;
  return `${why(added)}, and the previous entry could NOT be put back (${why(restored)}). This folder has no Claude Code local entry now: run \`retasc bind\` in it to reconnect`;
}

export type UpdateDeps = {
  version: string;
  findGlobal: () => { bin: string; version: string } | null;
  install: (version: string) => string | null;
  durableOnPath: () => string | null;
  folders: () => string[];
  claudeLocal: (dir: string) => McpEntry | undefined;
  replaceClaudeLocal: (dir: string, next: McpEntry, prev: McpEntry) => string | null;
  rewire: (launcher: Resolved) => SetupResult;
  /** Is `<dir>/.mcp.json` tracked by git? A rewrite then shows up as a diff in that repo. */
  isTracked: (file: string) => boolean;
  /** What the registry said about `latest`: "current" when this build is it, "unknown"
   *  when it could not be asked. (Behind never reaches here: `updateAction` delegates.) */
  registry: "current" | "unknown";
  /** RTSC-1153 — the background run: only the global install and untracked folder
   *  markers. No harness re-wiring, no Claude Code entry swaps, no git-tracked files. */
  auto?: boolean;
  /** RTSC-1153 — is this global install a developer's `npm link`? A background run never
   *  replaces one with a registry build. */
  linked?: (bin: string) => boolean;
  out: (line: string) => void;
};

/** What happened, for tests; the receipt is printed as it goes. `ok` is false when any
 *  step failed, which the command turns into a non-zero exit. */
export type UpdateReport = {
  ok: boolean;
  global: "absent" | "current" | "upgraded" | "failed";
  launcher: Resolved["launcher"];
  repinned: string[];
  failed: string[];
};

export function runUpdate(deps: UpdateDeps): UpdateReport {
  const v = deps.version;
  const out = deps.out;
  const failed: string[] = [];
  out(`Updating Retasc on this machine to ${v}.`);

  // 1. The global install.
  let global: UpdateReport["global"] = "absent";
  let bin: string | undefined;
  const found = deps.findGlobal();
  if (found) {
    bin = found.bin;
    if (deps.auto && deps.linked?.(found.bin)) {
      global = "current";
    } else if (compareVersions(found.version, v) >= 0) {
      // Equal or newer: never downgrade (see `repin`). A newer one still starts fine.
      global = "current";
      out(`  · Global install already at ${found.version}`);
    } else {
      const failure = deps.install(v);
      if (failure) {
        global = "failed";
        failed.push("global install");
        out(`  ! Couldn't upgrade the global install at ${found.bin} (${clean(failure)}).`);
        out(`    By hand: npm i -g ${PKG}@latest`);
      } else {
        global = "upgraded";
        out(`  ✓ Global install ${found.version} → ${v}`);
      }
    }
  }

  // 2. The machine-wide entries. The global binary when it now runs this version, by name
  //    when that name is what PATH finds and by path otherwise; npx `@latest` when there is
  //    no global install or it could not be brought up to date (RTSC-1153: npx resolves the
  //    tag itself, so that entry never needs this command again).
  let launcher: Resolved;
  if (bin && (global === "current" || global === "upgraded")) {
    const onPath = deps.durableOnPath();
    launcher =
      onPath && resolve(onPath) === resolve(bin)
        ? { launcher: { command: "retasc", args: [] }, how: "on-path", verified: true }
        : { launcher: { command: bin, args: [] }, how: "absolute", binPath: bin, verified: true };
  } else {
    launcher = { launcher: { command: "npx", args: ["-y", LATEST_SPEC] }, how: "npx", verified: true };
  }
  // RTSC-1153 — never in the background. Re-wiring swaps each harness's entry with a
  // remove-then-add that has a window in which the entry is gone; with a human at the
  // terminal a failure is seen, unattended it would leave a harness with no Retasc and
  // no proxy left to report it. A global upgrade keeps the same path, so the entries
  // that name it need nothing; a machine on old pinned entries reports `failed` (its
  // proxy stays behind) and the server asks its human to run this command by hand.
  if (!deps.auto) {
    const wired = deps.rewire(launcher);
    if (wired.wired.length) out(`  ✓ Re-wired ${wired.wired.map((w) => w.label).join(", ")}`);
    for (const f of wired.failed) {
      failed.push(f.label);
      out(`  ! ${f.label}: ${clean(f.reason)}`);
    }
    // The session hooks are what record the transcript and the model, which is half of what
    // an old build was missing, so a hook that did not wire is a failure here too.
    const hooks = [
      ...(wired.hook ? [{ label: "Claude Code", ...wired.hook }] : []),
      ...(wired.sessionHooks ?? []),
    ];
    for (const h of hooks) {
      if (!("reason" in h)) continue;
      failed.push(`${h.label} session hook`);
      out(`  ! ${h.label} session hook: ${clean(h.reason)}`);
    }
  }

  // 3. The per-folder markers.
  const repinned: string[] = [];
  for (const dir of deps.folders()) {
    const shown = clean(tildePath(dir));
    try {
      // RTSC-1153 — a background run never leaves a diff in someone's repo. A tracked pin it
      // skips keeps starting the old build, which the proxy then reports as `failed`, and
      // the server's stale-CLI notice tells the human to run this command by hand.
      const skip = deps.auto && deps.isTracked(join(dir, ".mcp.json"));
      const from = skip ? null : repinFolderMarker(dir);
      if (from) {
        repinned.push(join(dir, ".mcp.json"));
        out(`  ✓ ${shown}/.mcp.json: ${clean(from)} → ${LATEST_SPEC}`);
        // A committed marker is shared: the rewrite is a diff in their repo, and a teammate
        // who pulls it gets the same pin. Said here so it is not a surprise in `git status`.
        if (deps.isTracked(join(dir, ".mcp.json"))) out(`    This file is tracked by git. Commit it so your teammates get the change too.`);
      }
    } catch (e) {
      failed.push(join(dir, ".mcp.json"));
      out(`  ! ${shown}/.mcp.json: could not read it (${clean((e as Error).message ?? e)}); left as it was.`);
    }
    // RTSC-1153 — the same remove-then-add, so interactive only (see the re-wiring above).
    const local = deps.auto ? undefined : deps.claudeLocal(dir);
    const next = repin(local);
    if (local && next) {
      const failure = deps.replaceClaudeLocal(dir, next.entry, local);
      if (failure) {
        failed.push(`${dir} (Claude Code local)`);
        out(`  ! ${shown} (Claude Code local scope): ${clean(failure)}`);
      } else {
        repinned.push(`${dir} (Claude Code local)`);
        out(`  ✓ ${shown} (Claude Code local scope): ${clean(next.from)} → ${LATEST_SPEC}`);
      }
    }
  }

  out(
    failed.length
      ? `\nFinished with ${failed.length} problem${failed.length === 1 ? "" : "s"} above. Restart your agent sessions to load ${v} where it did apply.`
      : deps.registry === "unknown"
        // Never "Done" on a version we could not check: this build may itself be behind.
        ? `\nBrought everything to ${v}, but couldn't check the registry for a newer release. ` +
          `For the newest: npm view ${PKG} version, then npx -y ${PKG}@<that version> update. ` +
          `Restart your agent sessions to load it.`
        : `\nDone. Restart your agent sessions to load ${v}; one already running keeps the build it started with.`,
  );
  return { ok: failed.length === 0, global, launcher: launcher.launcher, repinned, failed };
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The published version, straight from npm, or null when npm cannot answer. Shape-checked
 *  because it becomes part of an argv (the re-exec below) and a printed command. */
export function npmLatest(): string | null {
  let r;
  try {
    r = spawnSync("npm", ["view", PKG, "version"], { encoding: "utf8", shell: WIN, windowsHide: true, timeout: 20_000 });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0) return null;
  const v = (r.stdout || "").trim();
  return VERSION_RE.test(v) ? v : null;
}

/**
 * Is this build the newest? If not, hand over to the one that is (RTSC-1127).
 *
 * `update` brings the machine to ITS OWN version, which is only the right target when it
 * is the newest. The notice always runs it pinned to latest, but a human who types a bare
 * `retasc update` on a global 1.57.0 with 1.58.0 out would otherwise be told "Done" and
 * stay behind: the "looks fixed, isn't" failure this command exists to end. So it asks the
 * registry first and, when behind, runs the pinned newest `update` in its place. The child
 * is that newest build, whose own check answers "current", so this cannot loop; the env
 * flag makes that structural rather than a property of the registry.
 */
export function delegateIfBehind(deps: {
  version: string;
  latest: () => string | null;
  exec: (latest: string) => number | null;
  delegated: boolean;
  out: (line: string) => void;
}): { delegated: true; status: number | null } | { delegated: false; registry: "current" | "unknown"; latest?: string } {
  if (deps.delegated) return { delegated: false, registry: "current" };
  const latest = deps.latest();
  if (!latest) return { delegated: false, registry: "unknown" };
  if (compareVersions(deps.version, latest) >= 0) return { delegated: false, registry: "current", latest };
  deps.out(`This is retasc ${deps.version}; ${latest} is published. Running npx -y ${PKG}@${latest} update instead.`);
  return { delegated: true, status: deps.exec(latest) };
}

const DELEGATED_ENV = "RETASC_UPDATE_DELEGATED";

/** How long a background update may take, end to end, before it is abandoned. */
const AUTO_TIMEOUT_MS = 15 * 60 * 1000;

/** Is this file tracked in its git repo? Best effort: no git, or not a repo, is "no". */
export function gitTracked(file: string): boolean {
  try {
    const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", file], {
      cwd: dirname(file),
      encoding: "utf8",
      timeout: 10_000,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/** The real-deps entry point. `auto` is the proxy's background run (RTSC-1153). */
export function updateAction(opts: { auto?: boolean } = {}): void {
  const auto = Boolean(opts.auto);
  const startedAt = Date.now();
  const out = auto ? () => {} : (line: string) => console.log(line);
  const isTarget = process.env[DELEGATED_ENV] === "1";
  const check = delegateIfBehind({
    version: VERSION,
    latest: npmLatest,
    exec: (latest) =>
      spawnSync("npx", ["-y", `${PKG}@${latest}`, "update", ...(auto ? ["--auto"] : [])], {
        stdio: auto ? "ignore" : "inherit",
        shell: WIN,
        windowsHide: true,
        env: { ...process.env, [DELEGATED_ENV]: "1" },
        // RTSC-1153 — a background run nobody watches must not hang forever on a stalled
        // registry. A timeout ends with a null status, which is recorded as a failure.
        ...(auto ? { timeout: AUTO_TIMEOUT_MS } : {}),
      }).status,
    delegated: isTarget,
    out,
  });
  if (check.delegated) {
    // The newest build records its own result. If it never got that far (npx could not
    // fetch it, or it died), record the failure here, or the machine would look healthy.
    if (auto && check.status !== 0) {
      const last = loadConfig().autoUpdateResult;
      if (!last || last.at < startedAt) {
        recordAuto({ ok: false, error: `npx could not run the newest build (exit ${check.status ?? "signal"})` });
      }
    }
    process.exitCode = check.status ?? 1;
    return;
  }
  // RTSC-1153 — a background run that was not handed over to is either offline or current.
  if (auto && !isTarget) {
    if (check.registry === "unknown") {
      // npm did not answer (offline, a VPN not up yet, no npm on the harness's PATH). Try
      // again in an hour rather than tomorrow. Not a failure on its own, since a laptop
      // offline for a morning is not broken, but three days of it is: see `reportedStatus`.
      retrySoon(startedAt);
      return;
    }
    // Current. The running build is the newest, but the global install may not be: a
    // session started through npx `@latest` can win the day's slot while the harnesses that
    // name the global binary stay behind. Bring it up too.
    // Only when THIS build is the published one: a newer local build (a release being
    // tested) has nothing on the registry to install, and would record a false failure.
    const g = findGlobal();
    if (g && check.latest === VERSION && !isLinkedInstall() && compareVersions(g.version, VERSION) < 0) {
      const failure = installGlobal(VERSION);
      recordAuto(failure ? { ok: false, error: `could not upgrade the global install: ${failure}` } : { ok: true, from: g.version });
      return;
    }
    recordChecked();
    return;
  }
  const report = runUpdate({
    version: VERSION,
    findGlobal,
    install: (v) => {
      out("  Upgrading the global install…");
      return installGlobal(v);
    },
    durableOnPath: () => durableOnPath(),
    folders: () => boundFolders(),
    claudeLocal: (dir) => claudeLocalRetascEntry(dir),
    replaceClaudeLocal,
    rewire: (launcher) => runSetup({ launcher, quiet: true }),
    isTracked: gitTracked,
    registry: check.registry,
    auto,
    linked: () => isLinkedInstall(),
    out,
  });
  // Interactive runs are recorded too, so a manual update clears a failure the background
  // run left behind instead of `doctor` and the proxy reporting it until the next release.
  recordAuto(report.ok ? { ok: true } : { ok: false, error: `could not update: ${report.failed.join(", ")}` });
  if (!report.ok) process.exitCode = 1;
}

/** RTSC-1153 — is the global `@retasc/cli` a developer's `npm link` (a symlink or, on
 *  Windows, a junction into a checkout)? A background run never replaces one. */
export function isLinkedInstall(prefix: string | null = npmGlobalPrefix()): boolean {
  if (!prefix) return false;
  for (const d of [join(prefix, "lib", "node_modules", "@retasc", "cli"), join(prefix, "node_modules", "@retasc", "cli")]) {
    try {
      if (lstatSync(d).isSymbolicLink()) return true;
    } catch {
      /* not there: the other layout */
    }
  }
  return false;
}

/** RTSC-1153 — npm could not be asked: move the day's stamp so the next start retries in
 *  an hour. Best effort, like everything a background run writes. */
function retrySoon(now: number): void {
  try {
    updateConfigIf(() => ({ autoUpdateAt: now - AUTO_UPDATE_INTERVAL_MS + AUTO_UPDATE_RETRY_MS }));
  } catch {
    /* tomorrow's attempt is the retry */
  }
}

/** RTSC-1153 — a check that completed with nothing to do. Clears an earlier failure: the
 *  machine is current, whatever went wrong before. */
function recordChecked(): void {
  try {
    const now = Date.now();
    updateConfigIf((cfg) => ({
      autoUpdateCheckedAt: now,
      autoUpdatePendingSince: undefined,
      ...(cfg.autoUpdateResult?.ok === false ? { autoUpdateResult: { at: now, from: VERSION, to: VERSION, ok: true } } : {}),
    }));
  } catch {
    /* unrecorded is only a staler `doctor` line */
  }
}

/** RTSC-1153 — what an update did, for `doctor` and for the proxy to report. A success
 *  is also a completed check. `updateConfigIf`, not `patchConfig`: it will not write
 *  defaults over a config it momentarily could not read. */
function recordAuto(r: { ok: boolean; error?: string; from?: string }): void {
  try {
    const now = Date.now();
    const env = process.env[UPDATE_FROM_ENV];
    const from = r.from ?? (env && VERSION_RE.test(env) ? env : VERSION);
    updateConfigIf(() => ({
      ...(r.ok ? { autoUpdateCheckedAt: now, autoUpdatePendingSince: undefined } : {}),
      autoUpdateResult: {
        at: now,
        from,
        ...(r.ok ? { to: VERSION } : {}),
        ok: r.ok,
        ...(r.error ? { error: r.error.slice(0, 200) } : {}),
      },
    }));
  } catch {
    /* a result we cannot write is one `doctor` cannot show; the update itself stands */
  }
}
