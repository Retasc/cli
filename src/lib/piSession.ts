// RTSC-1084 — which conversation a Pi session is, derived from the folder.
//
// WHY THIS EXISTS AT ALL. Every other harness TELLS us: Claude Code through a
// SessionStart hook, Grok through `GROK_SESSION_ID`, Codex/Cursor/Gemini/OpenCode
// through the adapters RTSC-822 shipped. Pi tells us nothing, and cannot be made to —
// it has no MCP client of its own (its README: "No MCP."), so it never handshakes with
// us, and the third-party `pi-mcp-adapter` that bridges it is not ours to change.
//
// THE DOCUMENTED ROUTE DOES NOT EXIST IN THE SHIPPED BUILD. pi.dev's environment-
// variables page lists `PI_SESSION_ID` and `PI_SESSION_FILE` as reaching Pi's shell
// tools, which would have made this the Grok pattern — a harness that puts its identity
// in the environment needs no adapter. Measured against pi 0.74.2 on 2026-09-21: those
// names appear NOWHERE in the install. Not in `dist`, not in its README, not in the
// dependency tree. The only PI_* variable that reaches a child is `PI_CODING_AGENT`
// (plus `AI_AGENT=pi`, which RTSC-1080 already reads to name the harness). So the docs
// describe a build this is not, and waiting for it would be waiting on someone else.
//
// WHAT IS LEFT IS THE FOLDER, and it is the same meeting point `sessionHook.ts` already
// relies on: the proxy's `process.cwd()` is the project directory, and Pi files its
// transcripts under a directory derived from exactly that. Nobody has to cooperate.
//
// THE LINE THIS DOES NOT CROSS. Only the transcript's ID is reported (RTSC-820), never
// the path and never a byte of the file (RTSC-791 — a path bakes in a username). The
// path is returned for LOCAL use only, the same way `HookRecord.transcriptPath` is: it
// is what lets RTSC-1070 read a dead session's own conversation, and it never becomes an
// argument to `record_session`.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Pi's session directory for a working directory.
 *
 * Derived, not guessed — checked against every folder on a real install:
 *
 *   /Users/em/retasc                     → --Users-em-retasc--
 *   /private/tmp/x/-Users-em-retasc-1/y  → --private-tmp-x--Users-em-retasc-1-y--
 *
 * Strip the leading separator, turn every remaining one into a dash, wrap in `--`.
 * The second example is the one that proves the rule rather than a simpler guess: a
 * path segment that ALREADY contains dashes is left alone, so this is a separator
 * substitution and not a sanitise.
 *
 * `PI_CODING_AGENT_DIR` moves Pi's whole config root and `PI_CODING_AGENT_SESSION_DIR`
 * moves just the sessions, both of which the proxy inherits when Pi spawned it — so
 * they are honoured here. A `--session-dir` flag on Pi's own command line is NOT
 * visible to us and is the one configuration this cannot follow; it yields no id
 * rather than a wrong one.
 */
export function piSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME || homedir(), ".pi", "agent");
  const sessions = env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(root, "sessions");
  const abs = resolve(cwd);
  const folder = `--${abs.replace(/^[/\\]/, "").replace(/[/\\]/g, "-")}--`;
  return join(sessions, folder);
}

/** A transcript file Pi wrote, with the session id its NAME carries. */
export type PiTranscript = { sessionId: string; path: string; at: number };

/**
 * Pi's filenames are `<ISO-ish timestamp>_<uuid>.jsonl`, e.g.
 * `2026-09-20T08-26-08-014Z_01a0bdec-310e-7d2f-baaa-2a7f4cf392ea.jsonl`.
 *
 * The id is taken from the NAME rather than by opening the file: it is the same uuid
 * `pi --session <id>` accepts, reading nothing costs nothing, and a transcript being
 * appended to by a live session is exactly the file we most want to avoid parsing.
 */
export function piSessionIdFromName(name: string): string | undefined {
  const m = /^[0-9TZ:.\-]+_([0-9a-f][0-9a-f-]{7,})\.jsonl$/i.exec(name);
  return m ? m[1] : undefined;
}

/**
 * The transcript for the session running in `cwd`, or undefined.
 *
 * NEWEST WINS, and it has to: a folder accumulates one file per session ever opened
 * there, and the live one is the one still being written. `notBefore` is the honesty
 * bound — the caller passes a moment the session cannot predate, and a file older than
 * that belongs to an EARLIER session in the same folder. Without it, opening Pi in a
 * folder used last week would confidently report last week's conversation.
 *
 * Never throws: a missing directory, an unreadable one and a folder of junk are all
 * simply "we cannot say", which is the answer every harness without an adapter gives.
 */
export function findPiTranscript(
  cwd: string,
  opts: { notBefore?: number; env?: NodeJS.ProcessEnv } = {},
): PiTranscript | undefined {
  const dir = piSessionDir(cwd, opts.env);
  if (!existsSync(dir)) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: PiTranscript | undefined;
  for (const name of names) {
    const sessionId = piSessionIdFromName(name);
    if (!sessionId) continue;
    const path = join(dir, name);
    let at: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      at = st.mtimeMs;
    } catch {
      continue;
    }
    if (opts.notBefore !== undefined && at < opts.notBefore) continue;
    if (!best || at > best.at) best = { sessionId, path, at };
  }
  return best;
}
