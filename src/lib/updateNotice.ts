// "You are running an old build" — the one thing the CLI never said (RTSC-520).
//
// A stale install is not merely missing features. CLI copy describes SERVER behaviour,
// so an old build makes false statements about the account in front of it: 1.11.0 told
// people a decline "covers the whole org, including later migrations" long after
// RTSC-507 made that untrue, and 1.10.0 had no Google door at all, so it sent a
// Google-only human through GitHub and minted them a second identity. Both are worse
// than a missing feature, because nothing on screen hints the sentence is out of date.
//
// The stance, and it is deliberate: NOTIFY, THEN ASK. Never a silent `npm i -g`. That
// mutates someone's machine unasked, fails on a root-owned prefix, and can swap the
// binary under a running agent. `resolveLauncher` already refuses to surprise-install
// for someone who manages their own install; this must not undercut it.
//
// Four rules fall out of that, and every one of them is a test below:
//   - Interactive only. No TTY ⇒ the notice, never the prompt and never the install.
//   - Never in the MCP proxy. An upgrade nag inside an agent's tool results is noise in
//     a machine channel. Structurally impossible here: the signal is only ever recorded
//     by `api.me()`, and the proxy does not import api.js.
//   - At most once a day, stamped in ~/.retasc/config.json. Declining must not re-ask on
//     the next command.
//   - A failed install is NOT a failed command. EACCES is the common one. Report it, name
//     the manual command, and carry on with whatever the human actually ran.
//
// RTSC-1153 — the stance above is now the fallback, not the default. With auto-update on
// (the default since 2026-09-28, see `autoUpdate.ts`) a stale build does not ask: it starts
// the same once-a-day background update the proxy starts, and says nothing. Everything
// below still applies to someone who turned auto-update off, and to CI.
//
// Everything goes to STDERR. `retasc issue list --json | jq` must keep working byte for
// byte, and a notice on stdout would break exactly the scripted callers the issue
// promises not to disturb.

import { VERSION } from "../version.js";
import { fileURLToPath } from "node:url";
import { loadConfig, patchConfig } from "../config.js";
import { confirm, isInteractive } from "./prompt.js";
import { installGlobal } from "./launcher.js";
import { autoUpdateHealthy, autoUpdateState, claimAutoUpdateSlot, maybeStartAutoUpdate, spawnDetachedUpdate } from "./autoUpdate.js";

const PKG = "@retasc/cli";
export const MANUAL_INSTALL = `npm i -g ${PKG}@latest`;

/**
 * How this copy of the CLI was started (RTSC-1092).
 *
 * THE REASON THIS EXISTS: `npm i -g` does not fix an npx-launched CLI. They are different
 * copies — the global prefix and `~/.npm/_npx/<hash>` — so upgrading the global one changes
 * nothing about a marker that starts npx. (RTSC-1153: the other half of the old claim here,
 * that npx never re-resolves `@latest`, is false on npm 11, which checks the registry for a
 * tag on every run. A PINNED spec is what stays put, and those are what `update` rewrites.)
 *
 * Telling that reader to run `npm i -g` is worse than telling them nothing: they follow it
 * exactly, nothing changes, and they now believe it is fixed.
 *
 * THE MODULE'S OWN PATH, not `npm_config_user_agent`. That variable is set by any npm
 * invocation, including `npm run` against a perfectly ordinary global install, so it
 * answers "did npm start me" when the question is "am I running out of the npx cache".
 * The path answers that directly and cannot be confused by an unrelated npm wrapper.
 */
export type Launcher = "npx" | "installed";

export function detectLauncher(modulePath: string): Launcher {
  // Windows separators too: the check is a path segment, not a substring of a URL.
  return /[\\/]_npx[\\/]/.test(modulePath) ? "npx" : "installed";
}

/**
 * What to actually run, given how this copy was started.
 *
 * Under npx the remedy is `update`, PINNED: an exact spec hashes to its own cache
 * directory, so it cannot be served a stale one, and `update` re-pins every npx marker on
 * the machine and upgrades a global install if there is one. It was `bind` until RTSC-1127,
 * which connects a folder rather than upgrading one: from the wrong folder it re-ran setup
 * and offered the org picker, and it left a working global `retasc` on the old build.
 */
export function remedyFor(launcher: Launcher, latest: string): string {
  if (launcher !== "npx") return MANUAL_INSTALL;
  // SHAPE-CHECKED before it goes into a command (RTSC-1092). Until now `latest` was only
  // ever interpolated into a SENTENCE; this is the first time it becomes part of a line a
  // human is invited to paste into a shell. The value arrives from the server via
  // `recordRelease(api.me())` and is stored in this machine's config, so a poisoned or
  // corrupted one would otherwise ride straight into that command. The server validates
  // it too — this is the second gate, on the side that prints it.
  //
  // Anything unexpected falls back to the unpinned spec: still correct, still `update`, one
  // npx resolution less deterministic. A degraded remedy beats a dangerous one.
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)
    ? `npx -y ${PKG}@${latest} update`
    : `npx -y ${PKG} update`;
}
/** Once a day. The notice is worth reading; a notice on every command is wallpaper. */
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What `manage:me` hands down. Every field optional — an OLD deployment doesn't send it. */
export type ReleaseSignal = { latest?: string | null; minHonest?: string | null };

/**
 * The signal from the most recent `me()` this process made.
 *
 * A module slot rather than a parameter because the notice fires from a postAction hook
 * that has no idea which commands talked to the backend. This is also what scopes the
 * feature correctly for free: only a login-gated command calls `me()`, so only a
 * login-gated command can ever have something to say.
 */
let recorded: ReleaseSignal | undefined;

/**
 * A published version and nothing else: three numbers, optionally a prerelease tag.
 *
 * Validated HERE as well as on the server, and not out of politeness. These strings do two
 * dangerous things: they are printed to a terminal, and `latest` is handed to `spawnSync`
 * as the version half of `@retasc/cli@<v>` — which on Windows runs through a shell. Trusting
 * the server for the CLI's own subprocess and terminal safety is the wrong shape of trust;
 * `formatError` already refuses it for backend error strings, for the same reason.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const clean = (v: unknown): string | null =>
  typeof v === "string" && VERSION_RE.test(v.trim()) ? v.trim() : null;

export function recordRelease(signal: unknown): void {
  if (!signal || typeof signal !== "object") return;
  const { latest, minHonest } = signal as ReleaseSignal;
  recorded = { latest: clean(latest), minHonest: clean(minHonest) };
}

export function releaseSignal(): ReleaseSignal | undefined {
  return recorded;
}

/** Test seam only — the slot is process-global by design. */
export function resetRelease(): void {
  recorded = undefined;
}

/**
 * Compare two versions: negative if a < b, 0 if equal, positive if a > b.
 *
 * Deliberately small. npm's `latest` dist-tag is a release, and this only ever compares
 * against it, so full semver precedence would be dead code — but a PRERELEASE has to
 * sort below its own release (`1.36.0-rc.1` < `1.36.0`) or someone testing an rc would
 * be told they are ahead of the world and never hear about the real 1.36.0.
 * Unparseable input answers 0, which reads as "no opinion" and keeps us silent.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1; // a release outranks any prerelease of itself
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export type UpdateOutcome = "silent" | "auto" | "noticed" | "declined" | "installed" | "install-failed";

export type UpdateDeps = {
  version: string;
  signal: () => ReleaseSignal | undefined;
  interactive: () => boolean;
  lastNoticeAt: () => number | undefined;
  stampNotice: (at: number) => void;
  ask: (question: string) => Promise<boolean>;
  install: (version: string) => string | null;
  out: (line: string) => void;
  now: () => number;
  /** How this copy was started. Decides the remedy, and whether offering to install a
   *  global copy would fix anything at all (RTSC-1092). */
  launcher: () => Launcher;
  /** RTSC-1153 — is auto-update on? Absent reads as off, which is today's behaviour. */
  autoUpdate?: () => boolean;
  /** RTSC-1153 — start the (throttled) background update instead of asking. */
  startBackground?: () => void;
  /** RTSC-1153 — did the last background update fail? Then it is not keeping this
   *  machine current, and the human hears about it here as before. */
  autoUpdateFailed?: () => boolean;
};

/**
 * The whole decision, with every edge injected so the interesting paths — no TTY, a
 * root-owned prefix, a deployment too old to send the field — can be tested without
 * owning a terminal, an npm prefix, or a backend.
 */
export async function offerUpdate(deps: UpdateDeps): Promise<UpdateOutcome> {
  const signal = deps.signal();
  const latest = signal?.latest;
  // No signal at all is the normal case for an old deployment or a cold cache, and it
  // means exactly one thing: we do not know, so we do not speak.
  if (!latest) return "silent";
  if (compareVersions(deps.version, latest) >= 0) return "silent";

  // RTSC-1153 — nothing to ask. The background update brings this machine current and
  // the next command runs the new build; saying so on every stale command would be noise.
  // Unless it is failing, or this build's wording no longer matches the server: both are
  // things the human must hear, so those fall through to the notice below.
  if (deps.autoUpdate?.()) {
    deps.startBackground?.();
    const dishonestNow = signal?.minHonest ? compareVersions(deps.version, signal.minHonest) < 0 : false;
    if (!dishonestNow && !deps.autoUpdateFailed?.()) return "auto";
  }

  const now = deps.now();
  const last = deps.lastNoticeAt();
  if (last !== undefined && now - last < NOTICE_INTERVAL_MS) return "silent";
  // Stamp on PRINT, not on answer: someone who declines and someone who ignores the line
  // have both been told today, and re-asking either tomorrow-minus-one-command is the
  // nagging this gate exists to prevent. Stamped before the prompt so a Ctrl-C mid-question
  // doesn't reset the clock either.
  deps.stampNotice(now);

  // Two different problems, said differently. "Newer exists" is an invitation; "your copy
  // no longer matches the server" is a warning that what they just read may be false.
  const dishonest = signal?.minHonest ? compareVersions(deps.version, signal.minHonest) < 0 : false;
  if (dishonest) {
    deps.out(`This retasc is ${deps.version}; ${latest} is published.`);
    deps.out("  Its wording no longer matches how the server behaves, so what it tells you about your account may be out of date.");
  } else {
    deps.out(`A newer retasc is available (${latest}, you have ${deps.version}).`);
  }

  const launcher = deps.launcher();
  const remedy = remedyFor(launcher, latest);

  // RTSC-1092 — under npx there is nothing to offer. Installing a global copy would
  // succeed and change nothing: the marker still names npx, npx still holds its cached
  // build, and the next session starts exactly the same old proxy. So say what is true,
  // name the command that works, and stop. Offering an install here is how a reader ends
  // up certain they fixed something they did not.
  if (launcher === "npx") {
    deps.out("  You are running from the npx cache. `npm i -g` updates a different copy and");
    deps.out("  would not change what starts.");
    deps.out(`  To fix it: ${remedy}`);
    return "noticed";
  }

  // No TTY: the notice is the whole of it. A scripted run keeps behaving as it does today.
  if (!deps.interactive()) {
    deps.out(`  To update: ${remedy}`);
    return "noticed";
  }

  if (!(await deps.ask("Update now?"))) {
    deps.out(`  Left alone. To update later: ${remedy}`);
    return "declined";
  }

  deps.out(`  Updating to ${latest}…`);
  const failure = deps.install(latest);
  if (failure) {
    // NOT a failed command. Whatever they actually ran already succeeded above this line.
    deps.out(`  Couldn't update (${failure}).`);
    deps.out(`  To do it by hand: ${remedy}`);
    return "install-failed";
  }
  // Say where it took effect, or the next thing they see will look like it didn't work:
  // this process is still the OLD build, and every already-running agent is still pointed
  // at the old MCP proxy. Same beat RTSC-519 added to `bind`.
  deps.out(`  ✓ Updated to ${latest}. It applies from your next command — restart your agents to pick up the new MCP server.`);
  return "installed";
}

/** The real-deps entry point. Never throws: a notice must not be able to fail a command. */
export async function maybeOfferUpdate(): Promise<UpdateOutcome> {
  try {
    return await offerUpdate({
      version: VERSION,
      signal: releaseSignal,
      interactive: isInteractive,
      lastNoticeAt: () => loadConfig().updateNoticeAt,
      // This module's own location answers "am I running out of the npx cache".
      launcher: () => detectLauncher(fileURLToPath(import.meta.url)),
      stampNotice: (at) => patchConfig({ updateNoticeAt: at }),
      ask: (q) => confirm(q),
      install: installGlobal,
      out: (line) => console.error(line),
      now: () => Date.now(),
      autoUpdate: () => autoUpdateState(process.env, loadConfig()).enabled,
      // Every way `reportedStatus` calls a machine failed, not only a recorded failure.
      autoUpdateFailed: () => {
        const cfg = loadConfig();
        return !autoUpdateHealthy(autoUpdateState(process.env, cfg), cfg);
      },
      startBackground: () => {
        maybeStartAutoUpdate({
          env: process.env,
          now: Date.now(),
          claimSlot: claimAutoUpdateSlot,
          config: loadConfig,
          spawnUpdate: () => spawnDetachedUpdate(fileURLToPath(new URL("../index.js", import.meta.url)), VERSION),
        });
      },
    });
  } catch {
    return "silent";
  }
}
