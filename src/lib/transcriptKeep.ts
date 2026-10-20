// RTSC-1057 — how long THIS machine keeps its transcripts.
//
// The Dash tells a reader that the conversation behind a session lives on the machine
// that ran it and is deleted after a while. The "while" was Claude Code's documented
// default, stated as a default, because nothing on the wire carried the real number. It
// is a local setting, so a machine told to keep them for a year had a panel quietly
// understating it by eleven months, and a machine told to keep them for a week had one
// promising three more than it has.
//
// The CLIENT can read it and the server cannot, which is the same boundary the folder
// name and the transcript id already sit on (RTSC-791, RTSC-820): the proxy reads its own
// machine and reports a NUMBER. No path and no file contents leave here.
//
// CLAUDE CODE ONLY, for now. `cleanupPeriodDays` is its setting and 30 is its default —
// measured rather than assumed, on a store of 501 transcripts with nothing older than 32
// days and the count thinning from 30. Codex, Gemini CLI, Cursor and OpenCode have no
// session hook here yet (RTSC-822); when one lands, its own retention lands with it.
// Returning `undefined` for them is what keeps the Dash from stating Claude Code's number
// over another tool's files.
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Claude Code's own default, when no settings file names one. */
export const CLAUDE_DEFAULT_KEEP_DAYS = 30;

/**
 * Where Claude Code reads settings from, STRONGEST FIRST — an enterprise policy overrides
 * a person's own file, and a folder's overrides their global one. The first file that
 * names `cleanupPeriodDays` wins, exactly as the harness resolves it.
 */
function settingsChain(cwd: string): string[] {
  const managed =
    platform() === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json";
  return [
    managed,
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
}

/** A whole number of days, or nothing. Anything else in the file is treated as unset. */
function readDays(file: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined; // not there, or not ours to read: both mean "this file says nothing"
  }
  try {
    const v = (JSON.parse(raw) as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
    // A malformed value is NOT a reason to guess. Fall through to the next file, and to
    // the harness default, rather than reporting a number nobody wrote.
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 3650 ? Math.floor(v) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The number of days this machine keeps `harness`'s transcripts, or `undefined` when we
 * cannot say. Never throws: a session must not fail to record because a settings file is
 * unreadable.
 */
export function transcriptKeepDays(harness: string | undefined, cwd: string): number | undefined {
  if (!harness || !/claude/i.test(harness)) return undefined;
  for (const file of settingsChain(cwd)) {
    const days = readDays(file);
    if (days !== undefined) return days;
  }
  return CLAUDE_DEFAULT_KEEP_DAYS;
}
