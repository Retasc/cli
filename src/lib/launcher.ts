import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// RTSC-493 — what an MCP client should actually spawn to start our proxy.
//
// The marker we write into a workspace names a command, and that command is run by
// something else, later, on every agent start. Until now it was the literal string
// `retasc`, which is only correct when the CLI was installed globally. The Dash tells
// people to run `npx @retasc/cli bind`, and npx unpacks into its own cache and puts
// NOTHING on PATH — so a bind that printed every success line could leave a folder
// whose agent cannot start the MCP server at all. The failure surfaced later, somewhere
// else, as a broken server rather than a failed setup.
//
// So the command is no longer assumed. It is resolved, and resolved by EXECUTING a
// candidate rather than trusting that an install worked: `npm i -g` can report success
// while its bin directory is absent from PATH, which is the exact middle case that made
// a shell one-liner (`npm i -g … && retasc …`) unable to fix this — the shell reports
// "command not found" and no code of ours ever runs to notice.

export type Launcher = { command: string; args: string[] };

/**
 * How the launcher was arrived at. The caller prints a different line for each,
 * because they leave the user in materially different positions: `installed` gained a
 * command they can use everywhere, `absolute` works but only from this marker, and
 * `npx` works but costs a registry round-trip on every agent start.
 */
export type LauncherHow = "on-path" | "installed" | "absolute" | "npx";

export type Resolved = {
  launcher: Launcher;
  how: LauncherHow;
  /** Absolute path to the global binary, when we found one (how: absolute). */
  binPath?: string;
  /** Why the global install didn't happen or didn't take (how: npx). */
  reason?: string;
  /**
   * Did this launcher actually run when we tried it?
   *
   * False only in the last-resort corner where even the npx fallback won't start. We
   * still have to write SOMETHING — refusing to write leaves the workspace with no entry
   * at all, which is not better — so the marker is written and the user is told plainly
   * that their agent cannot start it yet. A quiet write here would recreate the exact
   * defect this issue exists to remove.
   */
  verified: boolean;
};

const PKG = "@retasc/cli";

// Windows shims are .cmd files, which cannot be spawned without a shell. Everywhere
// else a shell is an injection surface for no benefit, so it stays off.
//
// WINDOWS IS NOT A SUPPORTED PLATFORM. The branches below are written to npm's
// documented layout and unit-tested for shape, but nothing here has ever been RUN on
// Windows. Treat them as best effort: they may well work, and a Windows bug report is
// not a regression against anything we claim. Kept rather than removed because throwing
// on win32 would break someone for whom it currently works, for no gain.
const WIN = process.platform === "win32";

/**
 * Does `command […args] --version` actually run, and print something version-shaped?
 *
 * Executing is the whole point. A binary can exist on disk and still be unusable (wrong
 * arch, broken symlink, a shim whose target was removed), and the version check also
 * guards against spawning some UNRELATED program that happens to be called `retasc`.
 */
export function runsOk(command: string, args: string[] = []): string | null {
  let r;
  try {
    r = spawnSync(command, [...args, "--version"], {
      encoding: "utf8",
      shell: WIN,
      timeout: 60_000,
    });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout || "").trim();
  // Our `--version` prints a bare semver (commander's .version()). Anything else is a
  // different program, and pointing a marker at it would be worse than not writing one.
  return /^\d+\.\d+\.\d+/.test(out) ? out : null;
}

/**
 * Is `retasc` on PATH in a way that OUTLIVES this process (RTSC-715)?
 *
 * `runsOk("retasc")` answers a subtly different question, and the difference cost a
 * fresh-machine setup its tools. When `bind` runs under `npx @retasc/cli@latest`, npx puts
 * its own cache directory on the child's PATH, so `retasc` resolves and runs:
 *
 *     outside npx:  which retasc => /Users/me/.npm-global/bin/retasc
 *     inside  npx:  which retasc => /Users/me/.npm/_npx/ccd2a9…/node_modules/.bin/retasc
 *
 * `resolveLauncher` read that as "already usable, leave it alone" and wrote a bare
 * `retasc` into the marker, marked verified, having genuinely run it. Then npx exited,
 * that directory left PATH, and the MCP client spawning the proxy got
 * `ENOENT: Executable not found in $PATH: "retasc"`. Setup reported success, the Dash
 * showed a healthy workspace, and no tools loaded.
 *
 * The probe was not sloppy. It measured the right thing on the wrong PATH: the one `bind`
 * inherited, rather than the one the agent spawns with later. So resolve the command to a
 * real path and reject the npx cache, which is transient by construction — the whole point
 * of `_npx` is that it is not a durable install.
 *
 * Resolved with `which`/`where` rather than by walking PATH ourselves: that is the lookup
 * the shell will actually do, PATHEXT and all, and reimplementing it is how this class of
 * bug gets a second edition.
 *
 * Anything unresolvable answers FALSE, deliberately. Every caller fallback (global install,
 * absolute path, pinned npx) still produces something that runs, whereas a wrong "yes"
 * produces a marker that cannot start. The two errors are not symmetric.
 */
export function onDurablePath(command = "retasc"): boolean {
  let r;
  try {
    r = spawnSync(WIN ? "where" : "which", [command], {
      encoding: "utf8",
      shell: WIN,
      timeout: 60_000,
    });
  } catch {
    return false;
  }
  if (r.error || r.status !== 0) return false;
  // `where` can print several matches; the first is the one that would run.
  const resolved = (r.stdout || "").trim().split(/\r?\n/)[0]?.trim();
  if (!resolved) return false;
  // The npx cache. Separators on both sides, so a project that happens to live in a
  // directory called `_npx` is not caught by it.
  if (/[\\/]_npx[\\/]/.test(resolved)) return false;
  return runsOk(resolved) !== null;
}

/** npm's global prefix, or null when npm itself can't be run. */
export function npmGlobalPrefix(): string | null {
  let r;
  try {
    r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: WIN, timeout: 60_000 });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout || "").trim();
  return out || null;
}

/**
 * Where npm puts the `retasc` shim for a global install.
 *
 * `npm bin -g` was REMOVED in npm 9, so it can't be asked directly — the prefix has to
 * be turned into a bin path by hand, and the layout differs by platform: POSIX nests a
 * `bin/`, Windows puts the `.cmd` shim straight in the prefix root.
 */
export function globalBinCandidates(prefix: string, win: boolean = WIN): string[] {
  return win
    ? [join(prefix, "retasc.cmd"), join(prefix, "retasc")]
    : [join(prefix, "bin", "retasc")];
}

/**
 * A launcher safe to write into a SHARED file. ALWAYS the pinned npx form.
 *
 * The absolute-path form is correct for the machine that resolved it and wrong everywhere
 * else: `./.mcp.json` is the secret-free marker the product describes as safe to commit,
 * so a path under someone's home directory both leaks their username into a committed
 * file and hands every teammate a command that does not exist on their machine.
 *
 * RTSC-879 — the bare `retasc` is NOT the safe fallback this function used to treat it as.
 * The old comment here said it "was at least portable", and that is only true across
 * machines that happen to have a global install. A container has none. Measured
 * 2026-09-09 in a Claude Code cloud session on a fresh clone of this repo: the committed
 * marker said `command: "retasc"`, and the MCP server died at
 * `ENOENT: Executable not found in $PATH: retasc` before it could do anything else. That
 * marker was written by a laptop where `resolveLauncher` found the binary on a durable
 * PATH and returned `how: "on-path"`, which this function then passed straight through as
 * though on-PATH-here meant on-PATH-anywhere.
 *
 * So there is no `how` worth preserving. `absolute` names a path nobody else has,
 * `on-path` and `installed` name a binary nobody else is guaranteed to have, and this
 * file is committed ON PURPOSE (see `.gitignore`, and the pre-commit guard that keeps it
 * secret-free). The only form true on every machine is the npx one.
 *
 * RTSC-1153 — `@latest`, not a pin. A pin (RTSC-1091) named one version until somebody
 * re-ran a command, so a committed marker went stale on every release and each teammate's
 * fix was a diff to commit. npm 11 checks the registry for a tag on every run and falls back
 * to its cached copy offline (measured 2026-09-28), so `@latest` keeps itself current.
 *
 * COST, stated plainly: sessions using the committed marker pay npx resolution at startup —
 * about 6s cold, and a registry check of roughly a second warm. That is the price of a
 * marker that starts at all on a machine that is not the one that wrote it and stays
 * current by itself, and it is paid ONLY here. `resolveLauncher`'s fast direct form is
 * still what goes into user-level configs, which never travel.
 */
export function portableLauncher(_r: Resolved, _version: string): Launcher {
  return { command: "npx", args: ["-y", `${PKG}@latest`] };
}

/**
 * How to spell "run this CLI again", for a message printed BEFORE anything has been made
 * durable (RTSC-492).
 *
 * `join` can stop for reasons that have nothing to do with us — an org with no projects,
 * a mint that failed — and every one of those has to name the command that resumes. Until
 * `resolveLauncher` has run there may be no `retasc` on this machine at all, so telling
 * someone to type `retasc bind …` would be telling them to type a command that does not
 * exist. That is the same defect as a marker naming a missing binary, just aimed at the
 * human instead of the agent.
 *
 * Decided from argv rather than by probing: it costs no subprocess, and it names the form
 * they DEMONSTRABLY have — they just used it. npx unpacks the package into its own `_npx`
 * cache and puts nothing on PATH, so a script path under that cache is proof of an npx run.
 */
export function selfCommand(version: string, argv1: string = process.argv[1] ?? ""): string {
  return /[\\/]_npx[\\/]/.test(argv1) ? `npx -y ${PKG}@${version}` : "retasc";
}

/**
 * A one-line stamp of which build just spoke (RTSC-672).
 *
 * A failure report is only diagnosable if it says what produced it. After 1.26.0 fixed
 * sign-in, a container kept printing the 1.25.0 message and the only way to learn why was
 * a round trip asking someone to run `--version` — because nothing in the output said.
 * Worse, the population most likely to re-run a command is the population that hit a bug
 * and was told it is fixed, which is exactly the population liable to be holding a stale
 * build. "It still doesn't work" and "you are running last week's CLI" look identical
 * without this.
 *
 * The EXACT version, not `@latest`: this names the code that emitted the message, which
 * is a different question from how to fetch the current one. `npx` in the prefix when
 * that is how they started, so the line doubles as a runnable command.
 */
export function versionStamp(version: string, argv1: string = process.argv[1] ?? ""): string {
  const how = /[\\/]_npx[\\/]/.test(argv1) ? `npx ${PKG}@${version}` : `${PKG} ${version}`;
  return `  (${how})`;
}

/**
 * Install (or upgrade to) an exact version globally. Returns null on success, and the
 * first useful line of npm's failure otherwise.
 *
 * Exported since RTSC-520, which upgrades an existing install rather than creating one —
 * same npm invocation, different reason. The "what is happening" line moved OUT to the
 * callers with it: a cold install takes seconds with no output of its own and silence
 * reads as a hang, but the sentence that makes sense mid-`bind` ("so your agent can start
 * it") is the wrong sentence for someone who just answered y to an update prompt.
 */
export function installGlobal(version: string): string | null {
  let r;
  try {
    r = spawnSync("npm", ["install", "-g", `${PKG}@${version}`], {
      encoding: "utf8",
      shell: WIN,
      // RTSC-1153 — this now also runs from a detached background update on Windows.
      windowsHide: true,
      // A cold global install pulls the tarball and its deps; 60s is not always enough.
      timeout: 180_000,
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (r.error) return r.error.message;
  if (r.status !== 0) {
    // EACCES is by far the common one (a prefix owned by root), and its first line is
    // the useful part — the rest is npm's log-file boilerplate.
    const msg = (r.stderr || r.stdout || "").trim().split("\n")[0];
    return msg || `npm exited ${r.status}`;
  }
  return null;
}

/**
 * Decide what the marker should name, and prove it before returning it.
 *
 * Order matters. An already-working `retasc` is left alone (no surprise installs for
 * someone who already manages their own). Otherwise we try to make one, and if the
 * install lands somewhere PATH can't see, the ABSOLUTE path to that binary is used
 * instead — verified to run, full speed, and immune to whatever is wrong with PATH.
 *
 * npx is last on purpose. It works, but it costs a registry round-trip on every agent
 * start (measured ~2.4s against ~0.06s for the binary). RTSC-1153 — it names `@latest`,
 * which resolves the newest release at each session start. That is the point: this
 * machine could not take a global install, so npx is the only thing that can keep it
 * current. A running session never changes version; only the next one does.
 */
export function resolveLauncher(opts: { version: string; install?: boolean }): Resolved {
  // 1. Already usable, and still usable after we exit? Leave it alone.
  //
  // RTSC-715 — `onDurablePath`, not `runsOk`. Under npx the bare name resolves into the
  // npx cache, which disappears when the command ends, so this branch used to write a
  // marker that could not start.
  if (onDurablePath("retasc")) {
    return { launcher: { command: "retasc", args: [] }, how: "on-path", verified: true };
  }

  const npxLauncher: Launcher = { command: "npx", args: ["-y", `${PKG}@latest`] };
  // Last resort, so it is probed too rather than assumed — the point of this whole
  // module is that nothing gets written into a marker on faith.
  const npxFallback = (reason: string): Resolved => ({
    launcher: npxLauncher,
    how: "npx",
    reason,
    verified: runsOk("npx", npxLauncher.args) !== null,
  });

  if (opts.install === false) return npxFallback("install not attempted");

  // 2. Try to make `retasc` real. Say so first — a cold install takes seconds in silence
  //    and this one lands in the middle of a bind, where silence reads as a hang.
  console.log("  Installing the retasc CLI so your agent can start it…");
  const failure = installGlobal(opts.version);

  // 3. Prove it, by running it. An exit code of 0 is not evidence the command resolves:
  //    npm can install happily into a prefix whose bin directory PATH never searches.
  if (!failure) {
    // RTSC-715 — `onDurablePath` here too, and this one is the subtler half. Under npx the
    // bare name still resolves to the npx cache AHEAD of the global bin we just installed
    // into, so a successful install would have been confirmed by running the wrong binary
    // and written the same unusable marker. The absolute-path loop below then covers the
    // real case this branch exists for: installed, but PATH cannot see it.
    if (onDurablePath("retasc")) {
      return { launcher: { command: "retasc", args: [] }, how: "installed", verified: true };
    }

    // Installed, but PATH can't see it. Name the file directly — this is the case a
    // shell one-liner can never recover from, because the shell fails before our code runs.
    const prefix = npmGlobalPrefix();
    for (const bin of prefix ? globalBinCandidates(prefix) : []) {
      if (existsSync(bin) && runsOk(bin)) {
        return { launcher: { command: bin, args: [] }, how: "absolute", binPath: bin, verified: true };
      }
    }
  }

  // 4. Nothing durable. Fall back, pinned, and let the caller say why.
  return npxFallback(failure ?? "installed, but the binary could not be located or run");
}

/** What to tell the user about the outcome. One line, or none when nothing happened. */
export function launcherNote(r: Resolved): string | null {
  switch (r.how) {
    case "on-path":
      return null; // nothing changed; saying so is noise
    case "installed":
      return "✓ Installed `retasc` so your agent can start it directly.";
    case "absolute":
      return (
        `✓ Installed retasc at ${r.binPath}\n` +
        "  Its folder isn't on your PATH, so your agent will use the full path above.\n" +
        `  To type \`retasc\` yourself, add this to your shell profile:\n` +
        `    export PATH="${r.binPath?.replace(/\/retasc$/, "")}:$PATH"`
      );
    case "npx":
      // Unverified is the one outcome where the workspace is written but NOT working.
      // Say that outright: the whole defect this replaces was a setup that reported
      // success and left the agent unable to start.
      if (!r.verified) {
        return (
          `! Couldn't install retasc${r.reason ? ` (${r.reason})` : ""}, and npx can't start it either.\n` +
          "  The marker was written, but your agent will NOT be able to start Retasc yet.\n" +
          "  Install the CLI, then run `retasc bind` again:  npm install -g @retasc/cli"
        );
      }
      return (
        `! Couldn't install retasc globally${r.reason ? ` (${r.reason})` : ""}.\n` +
        "  Your agent will start it through npx instead, which works but is slower\n" +
        "  and needs the network. To fix it later, run:  npm install -g @retasc/cli"
      );
  }
}
