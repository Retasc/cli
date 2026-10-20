import { loadConfig } from "../config.js";
import {
  claudeConfigPath,
  isNetworkError,
  readGlobalBinding,
  readLocalBinding,
  readShadowedBinding,
  resolveBinding,
  sameIdentity,
} from "../lib/binding.js";
import { AUTO_WORKSPACE, getBinding } from "../lib/keystore.js";
import { gitCommonDir } from "../lib/gitRepo.js";
import { detectHarnesses } from "../lib/harness.js";
import { runsOk } from "../lib/launcher.js";
import { skillLines, skillReport } from "../lib/skill.js";
import { clean } from "../lib/text.js";
import { autoUpdateHealthy, autoUpdateState, describeAutoUpdate } from "../lib/autoUpdate.js";

// RTSC-91 (DESIGN §13): `retasc doctor` — confirm THIS folder is correctly and
// safely bound. The question a human actually has is "which org/project does
// this folder talk to?", so the healthy answer is ONE line naming them.
//
// RTSC-262: a binding is found in either legal per-folder location —
// ./.mcp.json or Claude Code's local scope (the DEFAULT `claude mcp add`
// writes). Reading only the former made doctor cry "not bound" about a working
// binding, which teaches people to distrust everything else it says. When both
// exist, we report the claude-local one (what Claude Code actually runs;
// local > project) and warn if a shadowed folder marker disagrees. The
// illegal-global check reads the entry's IDENTITY, not merely its presence
// (RTSC-878), and never prints an all-clear it can't prove (unreadable config
// ≠ no global server).

const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);

// Server- and config-derived strings end up inside doctor's verdict lines; a
// hostile endpoint (reachable via a config-supplied legacy url) must not be
// able to smuggle ANSI escapes into the very output people trust for ✓/✗.
// Shared with join/bind — see lib/text.ts for why anything off the wire is sanitized
// before it reaches a terminal (RTSC-492).

/**
 * RTSC-493: can the registered entry actually be STARTED on this machine?
 *
 * Every other check here asks whether the binding is right. This one asks whether it can
 * run at all, which is a different failure and an invisible one: the entry names a
 * command, something else spawns it later, and when that command isn't there the only
 * symptom is an agent with no Retasc tools. Nothing points back here.
 *
 * Folders bound before the fix carry a bare `retasc` that npx never installed, and
 * re-binding is what repairs them, so this is the surface that has to say so.
 */
export function launcherVerdict(
  local: { command?: string; args?: string[] },
  probe: (cmd: string, args: string[]) => unknown = runsOk,
): { startable: boolean; shown: string } | null {
  if (!local.command) return null; // HTTP transport spawns nothing

  // The stored args end in `mcp-proxy` (the subcommand). Probe the LAUNCHER, so drop it.
  const args = local.args ?? [];
  const probeArgs = args[args.length - 1] === "mcp-proxy" ? args.slice(0, -1) : args;
  // RTSC-879 — an npx marker is probed by asking whether NPX runs, never by running the
  // package spec. `runsOk` executes what it is handed, so probing `npx -y @retasc/cli@X`
  // means a registry fetch and an install on every `doctor` — slow when it works, and a
  // false "your agent CANNOT start Retasc" the moment the machine is offline or npm is
  // unreachable. What this check is actually asking is whether the LAUNCHER exists, and
  // for the npx form that question is answered by `npx --version`.
  //
  // WHAT THIS STOPS CHECKING, said out loud: it proves the launcher exists and nothing
  // about the pinned spec. A version that is not on npm, a registry behind a proxy, or a
  // corrupt npx cache all read as healthy here while the server dies at startup. That is
  // the deliberate trade — a false "CANNOT start" every time someone is offline is worse
  // than a rare false "can" — but since 1.49.0 every shared marker is this form, so it
  // is a blind spot on the common path, not an edge one.
  if (local.command === "npx") {
    return {
      startable: Boolean(probe("npx", ["--version"])),
      shown: clean([local.command, ...probeArgs].join(" ")),
    };
  }
  return {
    startable: Boolean(probe(local.command, probeArgs)),
    shown: clean([local.command, ...probeArgs].join(" ")),
  };
}

/**
 * RTSC-878: is the machine-global entry a real registration, or the marker `setup` writes?
 *
 * The old rule was presence alone, and it was correct when it was written (RTSC-91): every
 * top-level `mcpServers.retasc` then carried a key or a workspace id, so any of them routed
 * every unbound folder on the disk to one org. RTSC-780 changed that world by making ONE
 * global entry mandatory, the keyless `auto` marker, which carries no identity at all: the
 * proxy resolves the folder it was spawned in and the org still comes from the folder.
 *
 * Doctor kept the old rule and so told people to delete what `retasc setup` had just
 * installed. Following that advice strips Retasc from every folder without a binding of its
 * own, and it happened to a real customer before this was fixed.
 *
 * The test is the marker's OWN sentinel rather than a shape heuristic: `RETASC_WORKSPACE`
 * is `auto` and no key resolved from it. Workspace ids are `ws_`-prefixed uuids
 * (`keystore.ts`), so `auto` can never be one, and an entry naming a real workspace stays
 * illegal exactly as before.
 *
 * The sentinel alone is NOT enough, and this is the trap the exemption has to survive.
 * `parseServerEntry` reads `RETASC_WORKSPACE` BEFORE it looks for a key in an
 * `Authorization` header or in `RETASC_MCP_KEY`, so an entry that carries BOTH the `auto`
 * sentinel and a real credential parses as an innocent keyless marker. That shape is a
 * live machine-global registration pointing every unbound folder at whatever org its key
 * names, which is the exact fault this check exists to catch, and it is not theoretical:
 * `lib/harness.ts` records an agent hand-writing a machine-global entry with an inline key.
 * So the raw entry is examined too, and anything carrying credential material or its own
 * endpoint is illegal no matter what its `env` claims.
 */
export function globalVerdict(global: {
  status: "none" | "unreadable" | "present";
  binding?: { key?: string; workspaceId?: string };
  raw?: unknown;
}): "clear" | "auto" | "unreadable" | "illegal" {
  if (global.status === "none") return "clear";
  if (global.status === "unreadable") return "unreadable";
  const b = global.binding;
  if (b && b.workspaceId === AUTO_WORKSPACE && !b.key && isBareMarker(global.raw)) return "auto";
  return "illegal";
}

/**
 * Does the entry as written carry nothing but the `auto` sentinel?
 *
 * Deliberately a DENYLIST of credential-bearing and endpoint-bearing fields rather than an
 * exact-shape match: `setup` may add a field to the marker later (it already grew `env`
 * once), and an exemption that broke on every such addition would be reverted rather than
 * updated. What must never be exempt is an entry that can reach a server on its own terms:
 * a key in `env`, a key in a header, or a `url` of its own.
 */
function isBareMarker(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, any>;
  if (e.url !== undefined) return false;
  if (e.headers !== undefined) return false;
  if (e.env && typeof e.env === "object" && e.env.RETASC_MCP_KEY !== undefined) return false;
  return true;
}

/**
 * RTSC-498: macOS is the only platform this CLI is tested on. That was true and written
 * down nowhere, which left someone on Linux or Windows unable to tell their own mistake
 * from a bug from a platform we never targeted.
 *
 * It says so HERE and not in the README because the README is read by everyone, and for
 * the majority on macOS a standing disclaimer about platforms they aren't using is pure
 * noise. `doctor` is the one surface that already knows which machine it's on, so the
 * people it concerns are exactly the people who see it. On darwin this returns null and
 * nothing is printed.
 *
 * Deliberately NOT a ✗ or a ! — this is context, not a fault in the folder being checked,
 * and it must not read as "your setup is broken".
 */
export function platformNote(platform: string = process.platform): string | null {
  if (platform === "darwin") return null;

  // Windows and Linux are the two we've actually committed to reaching. Everything else
  // (freebsd, aix, sunos…) is untested AND unplanned, so it must not be told its support
  // is "on the list" — that would be exactly the unearned promise this note exists to
  // avoid making. It still gets the note; it just doesn't get the roadmap sentence.
  const planned = platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : null;
  // `clean` for the same reason every other interpolation in this file uses it: nothing
  // reaches a verdict line able to smuggle ANSI escapes. `process.platform` is a Node
  // build-time constant today, but this is an exported function with a caller-supplied
  // parameter, and the safe version costs nothing.
  const name = planned ?? clean(platform);

  const note =
    `Note: ${name} is not a platform we test. macOS is the only one we support today.\n` +
    `      Much of the CLI is plain Node and should work fine here, but nothing on this\n` +
    `      platform is exercised, so a failure isn't a regression against a promise we\n` +
    `      made.`;
  return planned ? `${note} Proper ${planned} support is on the list, as bandwidth allows.` : note;
}

/**
 * RTSC-1153 — `doctor` no longer warns about a marker that says `@latest`. RTSC-1091/1092
 * added that warning on the premise that npx never re-resolves a tag, so `@latest` froze
 * on the first version it fetched. npm 11 re-resolves a tag on every run (libnpmexec
 * `missingFromTree`, `preferOnline`), measured 2026-09-28, and `@latest` is now what
 * `bind` itself writes into a shared marker. What goes stale is a PIN, and the machine's
 * auto-update line below says whether anything is keeping it current.
 */
function checkLauncher(local: { command?: string; args?: string[] }): void {
  const v = launcherVerdict(local);
  if (!v) return;
  if (v.startable) {
    ok(`your agent can start Retasc (${v.shown}).`);
    return;
  }
  // RTSC-879 — the remedy differs by form, because a global install no longer changes
  // what `bind` writes into a SHARED marker: `portableLauncher` emits the npx form for
  // every resolution now, so "install it globally and re-bind" would rewrite the
  // identical entry and fix nothing.
  bad(
    local?.command === "npx"
      ? `your agent CANNOT start Retasc — this folder is registered to run "${v.shown}",\n` +
          `    and npx itself did not run here. That is a Node/npm problem, not a Retasc one.\n` +
          `    Fix:  make sure \`npx --version\` works, then try again. If this machine is\n` +
          `          offline or npm is unreachable, that is the cause and nothing is broken.`
      : `your agent CANNOT start Retasc — this folder is registered to run "${v.shown}",\n` +
          `    which doesn't run on this machine. The binding itself is fine; the command is missing.\n` +
          `    Fix:  re-run \`retasc bind\` here — it now writes a portable npx entry that\n` +
          `          starts on any machine with Node, including one with no global install.`,
  );
}

export async function doctorAction(): Promise<void> {
  const cfg = loadConfig();
  const cwd = process.cwd();
  console.log(`Retasc workspace check — ${cwd}\n`);

  // An override redirects BOTH the folder lookup and the global safety check,
  // so its presence must be visible, not silent (it's a test hook, but nothing
  // stops an .envrc or CI env from setting it).
  if (process.env.RETASC_CLAUDE_CONFIG) {
    warn(`RETASC_CLAUDE_CONFIG is set — inspecting ${claudeConfigPath()} instead of ~/.claude.json.`);
  }

  // 1) Which org/project does this folder talk to?
  let networkDown = false;
  const local = readLocalBinding(cwd);
  if (!local) {
    bad("not bound — no Retasc MCP server for this folder. Run `retasc bind`.");
  } else if (local.markerOnly) {
    if (local.workspaceId) {
      // RTSC-92: marker present (e.g. a cloned repo) but no key in this
      // machine's keystore. Safe — the agent gets no tools — but must bind.
      warn(`workspace marker present (${clean(local.workspaceId)}) but no key in your keystore.`);
      bad("not usable yet on this machine — run `retasc bind` to mint your own key.");
    } else {
      // An entry is registered (and the runtime will use it) but carries no
      // key material the CLI recognizes — likely hand-edited.
      warn(`a Retasc server is registered for this folder (${local.source} scope) but the CLI can't read a key from it.`);
      bad("not usable by the CLI — re-run `retasc bind` to rewrite it.");
    }
  } else {
    // The healthy path is a single line: bound, and to WHAT. Server-resolved so
    // it's the same answer the agent gets, not a local guess.
    try {
      const b = await resolveBinding(local.url || cfg.mcpUrl, local.key);
      ok(`bound — org "${clean(b.org.name)}" / project ${clean(b.project.prefix)} (${clean(b.project.name)}).`);
    } catch (e: any) {
      const msg = clean(e?.message ?? e);
      if (isNetworkError(e)) {
        // The binding EXISTS; we just can't verify it. Don't send the user off
        // to re-bind over a dead wifi link or a server having a bad minute.
        networkDown = true;
        warn(`binding present (${local.source} scope) but no usable answer came back: ${msg}.`);
      } else {
        bad(`key not accepted by the server: ${msg}. Re-run \`retasc bind\`.`);
      }
    }

    // Directly under the headline, because "bound to org X" reads as an all-clear and
    // this is the one way it can be true and the folder still not work (RTSC-493).
    // Local and independent of the server, so it runs even when the network is down.
    checkLauncher(local);

    // RTSC-1153 — whether anything keeps this machine current. Off, or a failed last run,
    // is the one state in which the machine goes stale, so it is a warning.
    const au = autoUpdateState(process.env, cfg);
    const line = describeAutoUpdate(au, cfg);
    if (autoUpdateHealthy(au, cfg)) ok(line);
    else warn(line);

    // Caveats below the headline — each is a real risk, none is the common case.
    if (local.workspaceId) {
      // The id resolved, but if it was bound at a different folder, this marker
      // may have reused someone else's id — surface it rather than silently use it.
      const entry = getBinding(local.workspaceId);
      if (entry?.boundPath && entry.boundPath !== cwd) {
        // RTSC-862 — a WORKTREE of the bound repo is the expected case now, not a
        // problem, so it must not be reported as one. Before this it read "bound at a
        // different folder… re-run bind", which is exactly the wrong advice: re-binding
        // a worktree mints a second key and a second agent for one repo, which is how
        // people ended up with three.
        const repo = gitCommonDir(cwd);
        const sameRepo = !!repo && gitCommonDir(entry.boundPath) === repo;
        if (sameRepo) {
          // Deliberately not "this folder is a worktree of it": the relation is
          // symmetric, so that sentence is false when the cwd is the main checkout and
          // the BOUND folder is the worktree, which is an ordinary way round.
          console.log(
            `  ℹ same repository as the bound folder:\n` +
              `    ${clean(entry.boundPath)}\n` +
              `    Worktrees share one binding, so this is expected. Nothing to do.`,
          );
        } else {
          warn(
            `this workspace id was bound at a different folder:\n` +
              `    ${entry.boundPath}\n` +
              `    If you didn't move this repo, re-run \`retasc bind\` to mint a key for THIS folder.`,
          );
        }
      }
    } else if (local.legacy) {
      warn("the key is stored inline in the config. Run `retasc bind` to move it to the keystore.");
    }

    // Bound in BOTH places with different identities: Claude Code uses the
    // local-scope entry, so a stale committed ./.mcp.json marker would quietly
    // mislead anyone reading the repo. Say which one wins. (Re-binding does NOT
    // clear the folder marker — bind writes local scope — so the advice is to
    // fix the marker itself.)
    const shadowed = readShadowedBinding(cwd);
    if (shadowed && !sameIdentity(local, shadowed)) {
      warn(
        `./.mcp.json ALSO carries a Retasc binding, and it differs from the one in use.\n` +
          `    Claude Code runs the local-scope entry (local > project); the folder marker is shadowed.\n` +
          `    Remove the stale retasc entry from ./.mcp.json, or align it with the binding in use.`,
      );
    }
  }

  // 2) The safety check: any illegal machine-global Retasc server?
  const global = readGlobalBinding();
  // Pulled out once: the verdict below is computed from the same entry, and reading it
  // through the union again inside a branch loses the `present` narrowing.
  const entry = global.status === "present" ? global.binding : undefined;
  const verdict = globalVerdict(global);
  if (verdict === "clear") {
    ok("no illegal global Retasc server.");
  } else if (verdict === "auto") {
    // RTSC-878: the entry `retasc setup` writes, and the one state doctor used to
    // condemn. Named rather than passed over in silence: someone who just ran `setup`
    // should see that the thing it wrote is the thing that is supposed to be there.
    ok("machine-wide Retasc entry is the keyless `auto` marker `retasc setup` writes;\n" +
      "    it names no org, so every folder still resolves its own binding.");
  } else if (verdict === "unreadable") {
    warn(
      "could not parse Claude Code's config — cannot verify there is no global Retasc server\n" +
        "    (a local-scope binding for this folder would be invisible too).",
    );
  } else {
    // Name the org it points at when we can: "leaks across orgs" is abstract,
    // "every unbound folder gets org X" is what makes someone act. A keyless entry
    // that names a WORKSPACE is still illegal (it routes every unbound folder to that
    // one binding); only the identity-free `auto` marker above is not. If the network
    // already failed above, don't burn another timeout.
    let points = "";
    if (entry?.key && !networkDown) {
      try {
        const b = await resolveBinding(entry.url || cfg.mcpUrl, entry.key);
        points = ` It points at org "${clean(b.org.name)}".`;
      } catch {
        /* unresolvable (revoked/offline) — the registration is still illegal. */
      }
    }
    bad(
      `GLOBAL Retasc server registered (Claude Code config, top level).${points}\n` +
        `    It captures every folder on this machine that has no binding of its\n` +
        `    own, so issues can land in the wrong project.\n` +
        `    Fix:  claude mcp remove -s user retasc`,
    );
  }

  // 3) Does the agent that will use this binding have the manual? (RTSC-855)
  //
  // A machine fact rather than a folder fact, so it comes after both folder checks.
  // It is still a check, not a footnote: everything above proves an agent can REACH
  // Retasc, and this is the one that says whether it will know what to do when it
  // gets there. Absence never touches the exit code, and `doctorAction` sets none.
  for (const line of skillLines(skillReport(detectHarnesses()))) console.log(line);

  // 4) Ambient context, not a verdict on this folder — so it trails the checks
  // rather than framing them, and on macOS it prints nothing at all.
  const note = platformNote();
  if (note) console.log(`\n${note}`);
}
