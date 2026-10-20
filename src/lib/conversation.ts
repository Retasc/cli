// RTSC-1150 — finding the harness process a proxy runs under.
//
// The proxy lives as long as the harness PROCESS, and a process outlives its
// conversations: `/clear` (and an in-app `/resume`) starts a new conversation in the
// same window without restarting any MCP server. The proxy keeps renewing every lease it
// saw claimed, and that is deliberate — a `/clear` very often means "fresh context, same
// issue", and a claim dropped mid-work costs far more than one held a little long. What
// was missing is that the NEW conversation had no idea the window still held anything.
//
// So the proxy writes the issue ids it holds to a file keyed by its harness's pid, and
// the harness's SessionStart hook (which does know the pid, from `CLAUDE_PID`) reads it
// on `clear`/`resume` and tells the new conversation. See `writeLeaseFile` and
// `leaseNotice` in sessionHook.ts. This module holds the one pure step the proxy needs.

/**
 * This process's ancestors, nearest first, from `ps -A -o pid=,ppid=` output.
 *
 * The proxy needs its harness's pid and nothing hands it over: `CLAUDE_PID` reaches a
 * hook but not an MCP server (measured on Claude Code 2.1.282), and the parent is not
 * always the harness — `npx` puts `npm exec` in between. So the proxy walks up and takes
 * the nearest ancestor a hook has written for (see `harnessPid` in proxy.ts).
 * Bounded, and stops at pid 1 and on a cycle, so a malformed table cannot spin it.
 */
export function parseAncestry(psOutput: string, startPid: number, max = 16): number[] {
  const parent = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }
  const out: number[] = [];
  let p = startPid;
  while (p > 1 && out.length < max && !out.includes(p)) {
    out.push(p);
    p = parent.get(p) ?? 0;
  }
  return out;
}

/**
 * RTSC-1155 — the harness process above `startPid`, for every harness, from
 * `ps -A -o pid=,ppid=,args=` output: the nearest ancestor that is not a wrapper.
 *
 * Claude Code names itself to its hooks (`CLAUDE_PID`); nothing else does. What every
 * harness does share is the shape of its process tree: it spawns its MCP servers and its
 * hooks itself, sometimes through `npx`/`npm exec` or a `sh -c` in between. Skipping
 * exactly those wrappers leaves the harness.
 *
 * Judged by the PROGRAM, never by a substring of the whole command line: `codex -C
 * ~/work/retasc` is Codex, not a retasc wrapper, and a match anywhere in the arguments
 * climbed past it to the terminal app every tab shares. And the walk never climbs ABOVE
 * an interactive shell (one not running `-c`): the harness is always below the shell the
 * user started it from, so reaching one means we are lost, and "no window" is the answer.
 */
export function findWindowPid(psOutput: string, startPid: number, max = 16): number | null {
  const rows = new Map<number, { ppid: number; args: string }>();
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
  }
  let p = startPid;
  const seen = new Set<number>();
  for (let i = 0; i < max && p > 1 && !seen.has(p); i++) {
    seen.add(p);
    const row = rows.get(p);
    if (!row) return null;
    const kind = classify(row.args);
    if (kind === "harness") return p;
    if (kind === "stop") return null;
    p = row.ppid;
  }
  return null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "cmd.exe", "pwsh", "pwsh.exe", "powershell", "powershell.exe"]);
const PACKAGE_RUNNERS = new Set(["npx", "npx.cmd", "npm", "npm.cmd"]);

function base(path: string): string {
  const b = path.split(/[\\/]/).pop() ?? path;
  return b.replace(/^-/, ""); // a login shell shows as `-zsh`
}

/** What one process is: a wrapper to climb through, the harness, or a shell we must not
 *  climb past. `args` is ps's command line; the first token is the program. */
function classify(args: string): "wrapper" | "harness" | "stop" {
  const tokens = args.trim().split(/\s+/);
  const exe = base(tokens[0] ?? "");
  if (SHELLS.has(exe)) return tokens.includes("-c") || tokens.includes("/c") || tokens.includes("-Command") ? "wrapper" : "stop";
  if (PACKAGE_RUNNERS.has(exe)) return "wrapper";
  if (exe === "retasc" || exe === "retasc.cmd") return "wrapper";
  if (exe === "node" || exe === "node.exe") {
    const script = tokens.slice(1).find((t) => !t.startsWith("-")) ?? "";
    const sb = base(script);
    // npm's and npx's own entry points, and the retasc CLI however it is installed.
    if (sb === "npm-cli.js" || sb === "npx-cli.js" || sb === "retasc") return "wrapper";
    if (/[\\/]@retasc[\\/]cli[\\/]/.test(script)) return "wrapper";
  }
  return "harness";
}
