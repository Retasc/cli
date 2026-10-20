// RTSC-855: is the Retasc Agent Skill on this machine?
//
// This check can only live here. The server sees a bearer token and nothing else, no
// filesystem and no working directory, so it cannot know whether `skills/retasc/SKILL.md`
// was ever installed and must not pretend to infer it. The CLI runs on the machine, and
// `doctor` and `setup` already report local facts, so they are the honest place to ask.
//
// What is at stake is not cosmetic. The MCP tools give an agent the ability to claim
// work; the skill is what tells it what a lease is, that a claim needs its own worktree,
// what a checkpoint is for, and how a handoff into review works. An agent with the tools
// and not the manual looks like it is working and quietly gets the protocol wrong.
//
// Absence is a FINDING, not a failure. Nothing here touches an exit code, and nothing
// here writes: installing the skill is a decision for the human, made with one command
// they can read before they run it.
//
// Explicitly NOT in scope: deciding whether an installed copy is STALE. That needs a
// version stamp on the published skill, which does not exist yet, and a guess at it
// would produce the one output worse than silence, a confident wrong answer about a
// file the human can see is right there.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Harness } from "./harness.js";
import { clean } from "./text.js";

/** The skill's folder name, and the name it is published under. */
export const SKILL_NAME = "retasc";

/**
 * The one command to print.
 *
 * Harness-agnostic on purpose: `npx skills add Retasc/skills` is the first of the three
 * routes our public README lists and the only one that is correct for all six harnesses
 * at once, so a machine with Codex and Cursor on it gets a single line rather than a
 * decision tree. The Claude Code plugin route and the git-clone route stay in the README
 * where somebody choosing between them is already reading.
 *
 * `-g` is load-bearing and was missing here first time round. The installer defaults to
 * PROJECT scope (`installGlobally = options.global ?? false`, and its interactive prompt
 * offers Project first), which installs into the current folder. Without the flag this
 * command would install the skill somewhere real, the agent would load it in that one
 * folder, and every other folder would keep being told to run the same command again.
 * Global is what "install this on my machine" means, and it is what a nudge printed by a
 * machine-wide check should hand you.
 */
export const SKILL_INSTALL_CMD = "npx skills add Retasc/skills -g";

export type SkillPresence = {
  /** The harness, as a human names it. This is all a reader needs: the install command
   *  is the same for every one of them, so a path would be a column nobody acts on. */
  label: string;
};

export type SkillReport = {
  /** Detected harnesses that can already read the skill. */
  installed: SkillPresence[];
  /** Detected harnesses that cannot. */
  missing: SkillPresence[];
};

/** A directory is "holding the skill" when the skill's own file is readable in it. A
 *  bare `retasc/` folder is not an installed skill, and `existsSync` follows symlinks,
 *  which is how a checkout linked into `~/.claude/skills` counts (see skills/README.md). */
function holdsSkill(dir: string): boolean {
  try {
    return existsSync(join(dir, SKILL_NAME, "SKILL.md"));
  } catch {
    return false;
  }
}

/**
 * Which of these harnesses can read the skill, and which cannot.
 *
 * Takes the DETECTED harnesses rather than detecting for itself, so the answer is about
 * agents that actually run here: telling someone the skill is missing from Gemini CLI on
 * a machine with no Gemini CLI is noise dressed as a finding, and both callers have the
 * detected list in hand already.
 */
export function skillReport(harnesses: Harness[]): SkillReport {
  const report: SkillReport = { installed: [], missing: [] };
  for (const h of harnesses) {
    let dirs: string[] = [];
    try {
      dirs = h.skillDirs();
    } catch {
      dirs = [];
    }
    // No known skills directory means we cannot answer for this harness, and the honest
    // move is to say nothing rather than to invent a path and report a miss against it.
    if (!dirs.length) continue;
    const entry = { label: h.label };
    (dirs.some(holdsSkill) ? report.installed : report.missing).push(entry);
  }
  return report;
}

const names = (list: SkillPresence[]) => clean(list.map((p) => p.label).join(", "));

/**
 * The lines to print, prefixes included, shared verbatim by `doctor` and `setup`.
 *
 * One renderer because the issue asks both surfaces to say the same thing, and two
 * copies of a sentence are two sentences the moment one of them is edited.
 *
 * `ℹ` and not `✗`: this is context about the machine, not a fault in the folder being
 * checked, and it sits in a report whose ✓/✗ marks people read as pass and fail.
 */
export function skillLines(report: SkillReport): string[] {
  // One harness with the skill is enough to say so and stop talking. The nudge exists for
  // the machine that has the manual NOWHERE; on a developer laptop that has Cursor and
  // Gemini installed but points neither at Retasc, listing them as missing on every run
  // is an unresolvable nag about work nobody intends to do, and a check people learn to
  // scroll past has stopped being a check. Which harnesses DO have it is named in the ✓
  // line, so nothing true is being hidden.
  if (report.installed.length) {
    return [`  ✓ the Retasc Agent Skill is installed (${names(report.installed)}).`];
  }
  if (!report.missing.length) return [];
  return [
    `  ℹ the Retasc Agent Skill is not installed for ${names(report.missing)}.\n` +
      `    It is what teaches an agent to work the queue: dispatch, leases, checkpoints,\n` +
      `    handing off through review. Without it an agent has the tools and not the manual.\n` +
      `    Install:  ${SKILL_INSTALL_CMD}`,
  ];
}
