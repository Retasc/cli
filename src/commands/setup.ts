// RTSC-780: `retasc setup` — wire every MCP harness on this machine, once.
//
// The shape this exists to deliver:
//   once per machine   `retasc setup`, and every harness that is installed gets an entry
//   once per project   `retasc bind`, and every one of them sees it
//
// Nothing harness-specific after that, ever again. The entry written here names no
// workspace (keystore.AUTO_WORKSPACE), so it is correct in every folder: the proxy
// resolves the directory it was spawned in against the home keystore at startup. The
// folder still decides the org, which is the whole routing model (RTSC-91) and the thing
// a machine-global entry would otherwise break.
//
// NOT an npm postinstall hook. Most people reach this CLI through `npx`, which installs
// nothing (the reason `resolveLauncher` exists, RTSC-493), so a postinstall would never
// run for them; and writing into somebody's global agent configs from a package install
// is a thing to do in front of a human, not behind one.

import { wireClaudeHook, wireCodexHook, wireCursorHook, wireGeminiHook, wireOpenCodePlugin, hookLauncher } from "../lib/sessionHook.js";
import { loadKeystore } from "../lib/keystore.js";

import { AUTO_WORKSPACE } from "../lib/keystore.js";
import { HARNESSES, detectHarnesses, tildePath, type Harness, type HarnessEntry } from "../lib/harness.js";
import { resolveLauncher, launcherNote, type Resolved } from "../lib/launcher.js";
import { skillLines, skillReport, type SkillReport } from "../lib/skill.js";
import { VERSION } from "../version.js";
import { card } from "../lib/card.js";

/** The one entry every harness gets: the watchdog proxy, resolving its own folder. */
export function autoMarkerEntry(launcher: Resolved["launcher"]): HarnessEntry {
  return {
    command: launcher.command,
    args: [...launcher.args, "mcp-proxy"],
    env: { RETASC_WORKSPACE: AUTO_WORKSPACE },
  };
}

export type SetupResult = {
  wired: { label: string; where: string; replaced: boolean }[];
  failed: { label: string; reason: string }[];
  /** RTSC-820 — the Claude Code SessionStart hook, when Claude Code is here. */
  hook?: { where: string; outcome: "added" | "updated" | "unchanged" } | { reason: string };
  /** RTSC-822 — the same thing for every other harness that can report a session.
   *  `caveat` is printed with the row: a harness whose hook is wired but will not fire
   *  yet (Codex's trust gate), or was never seen firing at all (Gemini). */
  sessionHooks?: Array<
    { label: string; where: string; outcome: "added" | "updated" | "unchanged"; caveat?: string } | { label: string; reason: string }
  >;
  /** Harnesses we know about that are not installed here. Named, not hidden: "Codex
   *  is not on this machine" is a different fact from "Codex was skipped". */
  absent: string[];
  /** RTSC-855 — which detected harnesses can already read the Retasc Agent Skill.
   *  Wiring the MCP server is half the job; the skill is the half that tells an agent
   *  what to do with the tools it just got. Reported, never installed from here. */
  skill: SkillReport;
};

/**
 * Wire the auto marker into every detected harness.
 *
 * `quiet` is for the call at the end of `bind`, where the bind receipt does the talking.
 */
export function runSetup(opts: {
  install?: boolean;
  launcher?: Resolved;
  quiet?: boolean;
  harnesses?: Harness[];
}): SetupResult {
  const all = opts.harnesses;
  const resolved = opts.launcher ?? resolveLauncher({ version: VERSION, install: opts.install });
  if (!opts.launcher) {
    const note = launcherNote(resolved);
    if (note) console.log(note);
  }
  const entry = autoMarkerEntry(resolved.launcher);

  const known = all ?? HARNESSES;
  const present = detectHarnesses(known);
  const presentIds = new Set(present.map((h) => h.id));
  const result: SetupResult = {
    wired: [],
    failed: [],
    absent: known.filter((h) => !presentIds.has(h.id)).map((h) => h.label),
    skill: skillReport(present),
  };

  for (const h of present) {
    const outcome = h.install(entry);
    if (outcome.ok) {
      result.wired.push({ label: h.label, where: tildePath(outcome.path), replaced: outcome.replaced });
    } else {
      result.failed.push({ label: h.label, reason: outcome.reason });
    }
  }
  // RTSC-820 — Claude Code hands its session id to hooks, not to MCP servers, so the
  // marker alone can never learn which conversation a session is. Same launcher as the
  // marker, so both resolve or neither does.
  if (presentIds.has("claude-code")) {
    const hooked = wireClaudeHook(hookLauncher(resolved.launcher, VERSION));
    result.hook = hooked.ok ? { where: tildePath(hooked.path), outcome: hooked.outcome } : { reason: hooked.reason };
  }

  // RTSC-822 — the other four. Each was probed on a real install on 2026-09-20 except
  // Gemini, whose caveat says so rather than letting a row imply it was watched working.
  const launcher = hookLauncher(resolved.launcher, VERSION);
  const others: Array<{ id: string; label: string; wire: () => ReturnType<typeof wireCodexHook>; caveat?: string }> = [
    {
      id: "codex",
      label: "Codex",
      wire: () => wireCodexHook(launcher),
      // Measured 2026-09-20: a freshly written Codex hook does NOT fire until it is
      // trusted. We do not write the trust hash ourselves — see `wireCodexHook`.
      caveat: "Codex will not run it until you trust it — start Codex once and approve the hook.",
    },
    { id: "cursor", label: "Cursor", wire: () => wireCursorHook(launcher) },
    { id: "opencode", label: "OpenCode", wire: () => wireOpenCodePlugin(launcher) },
    {
      id: "gemini",
      label: "Gemini CLI",
      wire: () => wireGeminiHook(launcher),
      caveat: "never confirmed against a running Gemini session — tell us if no id appears.",
    },
  ];
  for (const o of others) {
    if (!presentIds.has(o.id)) continue;
    const w = o.wire();
    (result.sessionHooks ??= []).push(
      w.ok
        ? { label: o.label, where: tildePath(w.path), outcome: w.outcome, ...(o.caveat ? { caveat: o.caveat } : {}) }
        : { label: o.label, reason: w.reason },
    );
  }

  if (!opts.quiet) printSetup(result);
  return result;
}

/** The receipt. One row per harness, so "what did this just touch" needs no guessing. */
export function printSetup(r: SetupResult): void {
  if (!r.wired.length && !r.failed.length) {
    console.log("No MCP harness found on this machine.");
    // Named from the registry rather than a hand-kept list: RTSC-780 shipped three and
    // RTSC-793 added three more, and a sentence naming only the original three would have
    // told a Cursor user to install Codex.
    console.log(
      `Install one of ${HARNESSES.map((h) => h.label).join(", ")} and run \`retasc setup\` again,\n` +
        "or bind a folder with `retasc bind` and paste the config block it prints into your\n" +
        "own client.",
    );
    return;
  }
  console.log(
    "\n" +
      card(
        `✓ Retasc wired into ${r.wired.length} ${r.wired.length === 1 ? "harness" : "harnesses"}`,
        r.wired.map((w) => ({
          label: w.label,
          value: w.where,
          note: w.replaced ? "updated" : "new",
        })),
      ),
  );
  for (const f of r.failed) console.log(`  ! ${f.label}: ${f.reason}`);
  if (r.hook) {
    if ("reason" in r.hook) console.log(`  ! Claude Code session hook: ${r.hook.reason}`);
    else if (r.hook.outcome !== "unchanged") console.log(`  ${r.hook.outcome === "added" ? "+" : "~"} Claude Code session hook in ${r.hook.where}, so the Dash can name each session's transcript.`);
  }
  // RTSC-822 — one row per other harness, and the caveat on its own line so a hook that
  // is wired but not yet live never reads as a hook that works.
  for (const h of r.sessionHooks ?? []) {
    if ("reason" in h) {
      console.log(`  ! ${h.label} session hook: ${h.reason}`);
      continue;
    }
    if (h.outcome !== "unchanged") {
      console.log(`  ${h.outcome === "added" ? "+" : "~"} ${h.label} session hook in ${h.where}, so the Dash can name each session's transcript.`);
    }
    if (h.caveat) console.log(`    ! ${h.caveat}`);
  }
  if (r.absent.length) console.log(`  Not on this machine: ${r.absent.join(", ")}.`);
  // RTSC-855 — next to the harness rows, because it is the same kind of fact: what this
  // machine has, and what it is still missing. `setup` wires the tools; the skill is the
  // document that tells an agent what to do with them, and nothing else on this receipt
  // would ever mention that it is absent. Never a failure, and never installed for you.
  for (const line of skillLines(r.skill)) console.log(line);
  console.log(
    "\nThese entries carry no key and name no project, so they are correct in every folder.\n" +
      "Run `retasc bind` in a project to say which org it belongs to, then start your agent\n" +
      "there (or restart it if it's already open).",
  );
}
