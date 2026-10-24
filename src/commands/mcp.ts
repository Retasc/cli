import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  resolveLauncher,
  launcherNote,
  portableLauncher,
  type Launcher,
  type Resolved,
} from "../lib/launcher.js";
import { VERSION } from "../version.js";
import { hasClaudeLocalPlaceholder } from "../lib/binding.js";
// The TOML dialects live with the rest of the TOML knowledge (harness.ts), not here:
// the same file has to keep Codex's and Grok's config shapes straight for the proxy form.
import { tomlHttpBlock } from "../lib/harness.js";

export const SERVER_NAME = "retasc";

// RTSC-493: every entry below spawns a command on EVERY agent start, so the command is
// passed in rather than assumed. It used to be the literal `retasc`, which is only true
// when the CLI was installed globally — and the Dash tells people to run it through npx,
// which installs nothing onto PATH. See lib/launcher.ts for how one is resolved (and
// proved) before any of these are called.

// RTSC-91 (DESIGN §13, override #1): there is NO global scope for Retasc. The
// org/project an agent acts in is decided by the workspace folder only — a
// machine-global server entry would let one binding apply everywhere and leak
// issues across orgs. Scope is per-folder: `local` (this project, not committed)
// or `project` (./.mcp.json). `user` is no longer accepted.
export type McpScope = "local" | "project";

/** Normalize a user-supplied scope string. `user` (global) is refused and
 * downgraded to `local`, loudly — per-folder binding is the only right way. */
export function normalizeScope(s: string | undefined): McpScope {
  if (s === "project") return "project";
  if (s === "user") {
    console.error(
      "  ! Global (--scope user) is not allowed for Retasc — each workspace must bind to\n" +
        "    exactly one org/project. Using per-folder scope (local) instead.",
    );
    return "local";
  }
  return "local";
}

/** The MCP server entry we wire into an agent's config. */
export function mcpServerEntry(url: string, key: string) {
  return {
    type: "http" as const,
    url,
    headers: { Authorization: `Bearer ${key}` },
  };
}

/** A copy-pasteable .mcp.json block (always shown as a fallback). */
export function mcpConfigBlock(url: string, key: string): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: mcpServerEntry(url, key) } },
    null,
    2,
  );
}

/**
 * Every direct-form block, labelled with the harnesses that read it (RTSC-864).
 *
 * The direct form is for a host that cannot spawn our proxy at all, such as a claude.ai
 * connector, Codex Cloud or a hosted OpenCode, where an HTTP URL and a bearer key is the
 * only door. Two config languages and three dialects, because `tomlHttpBlock` documents
 * that Codex and Grok silently ignore each other's header key.
 *
 * Printed by `key mint` in the same breath as the key itself, and NOT only when some
 * install failed: the key is shown once, so every form a person might have to paste it
 * into has to be on the screen while it is still readable. Sending them to a doc after
 * the one credential they were given has scrolled away is how a key gets re-minted.
 */
export function directFormBlocks(url: string, key: string): string {
  return [
    "Remote-key config, for a host that cannot run a local process",
    "(claude.ai connectors, Codex Cloud, CI, any hosted agent):",
    "",
    "  JSON, for Claude Code, Cursor, OpenCode and Gemini CLI:",
    "",
    mcpConfigBlock(url, key),
    "",
    "  TOML, for Codex (~/.codex/config.toml):",
    "",
    tomlHttpBlock(url, key, "codex"),
    "",
    "  TOML, for Grok (~/.grok/config.toml):",
    "",
    tomlHttpBlock(url, key, "grok"),
    "",
    // The hook is not a style preference and the reason belongs next to the block that
    // would trip it: a committed key is readable by everyone who ever clones the repo,
    // and stays readable in git history after it is deleted.
    "These blocks carry a live credential. Put them in the harness's own user-scope",
    "config or the platform's secret store, never in a tracked `.mcp.json`. Retasc's own",
    "repo refuses one at pre-commit, because a key committed once stays readable in git",
    "history long after it is deleted.",
    "Where the host DOES give you an environment, prefer the proxy with `RETASC_MCP_KEY`",
    "set as a secret: it keeps your leases alive for you.",
  ].join("\n");
}

/**
 * The stdio server entry that runs the liveness watchdog proxy (RTSC-44). The
 * harness spawns `retasc mcp-proxy`, which forwards to the remote MCP and keeps
 * claimed issues' leases alive automatically. url+key go via env (not a header,
 * since this is a spawned command). Harness-agnostic: any stdio MCP client works.
 */
export function mcpProxyEntry(url: string, key: string, launcher: Launcher) {
  return {
    command: launcher.command,
    args: [...launcher.args, "mcp-proxy"],
    env: { RETASC_MCP_URL: url, RETASC_MCP_KEY: key },
  };
}

/** Copy-pasteable watchdog block for Codex / OpenCode / any stdio MCP client. */
export function mcpProxyConfigBlock(url: string, key: string, launcher: Launcher): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: mcpProxyEntry(url, key, launcher) } },
    null,
    2,
  );
}

/**
 * RTSC-92: the SECRET-FREE watchdog marker. No key — only the opaque workspace
 * id, which the proxy resolves to a key through the home keystore. Safe to
 * commit; doubles as the "this repo is a Retasc workspace" marker.
 */
export function mcpMarkerEntry(workspaceId: string, launcher: Launcher) {
  return {
    command: launcher.command,
    args: [...launcher.args, "mcp-proxy"],
    env: { RETASC_WORKSPACE: workspaceId },
  };
}

export function mcpMarkerConfigBlock(workspaceId: string, launcher: Launcher): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: mcpMarkerEntry(workspaceId, launcher) } },
    null,
    2,
  );
}

// Outcome of a `claude mcp add` attempt: succeeded, the CLI is genuinely absent
// (ENOENT), or the CLI ran but the command failed (RTSC-99 — never conflate the
// last two: a failed add was being misreported as "CLI not detected").
type AddResult = { ok: true } | { ok: false; absent: boolean; msg?: string };

// --- `claude mcp add` argv builders (pure, exported for tests) -------------
// RTSC-99: the stdio builders put SERVER_NAME *before* the variadic `--env`
// flags. `--env` consumes every following non-`--` token, so a server name after
// it was eaten as a bogus env var ("Invalid environment variable format: retasc").
// Name-first + a closing `--` keeps env values bounded and the command intact.

/** Build `claude mcp add` argv for the HTTP transport. (`url` is a positional
 *  BEFORE the variadic `--header`, so the header flag can't swallow it.) */
export function buildHttpAddArgs(url: string, key: string, scope: McpScope): string[] {
  return [
    "mcp", "add",
    "--transport", "http",
    "--scope", scope,
    SERVER_NAME, url,
    "--header", `Authorization: Bearer ${key}`,
  ];
}

/** Build argv for the stdio watchdog proxy (RTSC-44). */
export function buildWatchdogAddArgs(
  url: string,
  key: string,
  scope: McpScope,
  launcher: Launcher,
): string[] {
  return [
    "mcp", "add",
    SERVER_NAME,
    "--transport", "stdio",
    "--scope", scope,
    "--env", `RETASC_MCP_URL=${url}`,
    "--env", `RETASC_MCP_KEY=${key}`,
    "--", launcher.command, ...launcher.args, "mcp-proxy",
  ];
}

/** Build argv for the secret-free stdio marker (RTSC-92). */
export function buildMarkerAddArgs(
  workspaceId: string,
  scope: McpScope,
  launcher: Launcher,
): string[] {
  return [
    "mcp", "add",
    SERVER_NAME,
    "--transport", "stdio",
    "--scope", scope,
    "--env", `RETASC_WORKSPACE=${workspaceId}`,
    "--", launcher.command, ...launcher.args, "mcp-proxy",
  ];
}

function tryClaudeCli(url: string, key: string, scope: McpScope): AddResult {
  return runClaudeAdd(buildHttpAddArgs(url, key, scope));
}

function tryClaudeCliWatchdog(
  url: string,
  key: string,
  scope: McpScope,
  launcher: Launcher,
): AddResult {
  return runClaudeAdd(buildWatchdogAddArgs(url, key, scope, launcher));
}

function tryClaudeCliMarker(
  workspaceId: string,
  scope: McpScope,
  launcher: Launcher,
): AddResult {
  return runClaudeAdd(buildMarkerAddArgs(workspaceId, scope, launcher));
}

function runClaudeAdd(args: string[]): AddResult {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  if (r.error) {
    // ENOENT = `claude` not on PATH (genuinely absent). Any other spawn error is
    // a real failure of a present CLI — report it as such, not as "not detected".
    const absent = (r.error as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, absent, msg: absent ? undefined : r.error.message };
  }
  if (r.status !== 0) {
    // CLI ran but rejected the command — present, not absent. Surface the real reason.
    const msg = (r.stderr || r.stdout || "").trim().split("\n")[0] || `exited ${r.status}`;
    return { ok: false, absent: false, msg };
  }
  return { ok: true };
}

/** The fallback note printed after writing .mcp.json — names the REAL reason the
 *  CLI path didn't take, never falsely claiming the CLI is missing (RTSC-99). */
export function fallbackNote(res: { absent: boolean; msg?: string }): string {
  return res.absent
    ? "(Claude Code CLI not detected — wrote .mcp.json instead.)"
    : `(claude mcp add failed${res.msg ? `: ${res.msg}` : ""} — wrote .mcp.json instead.)`;
}

/** Merge a given server entry into ./.mcp.json (project scope on disk).
 *  The inline-key fallback forms (mcpServerEntry / mcpProxyEntry) embed the API
 *  key, so lock the file to 0600. The secret-free marker (mcpMarkerEntry) doesn't
 *  need it, but chmod'ing unconditionally is harmless and keeps this the single
 *  correct path. Exported for the permission test. */
export function writeProjectMcpJson(entry: object): string {
  const path = join(process.cwd(), ".mcp.json");
  let doc: any = {};
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      doc = {};
    }
  }
  doc.mcpServers = doc.mcpServers ?? {};
  doc.mcpServers[SERVER_NAME] = entry;
  // May carry an inline API key — create it 0600 so it's never world-readable,
  // even for the sub-ms before the chmod (which only closes an existing 0644 file,
  // since the write mode above doesn't apply when overwriting).
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
  return path;
}

/**
 * Say plainly that `--runtime` labels an agent and does not choose a harness (RTSC-781).
 *
 * The flag reads as a promise. It is offered on the same commands that install MCP
 * config, it is documented with a list of harness names, and before RTSC-780 the only
 * thing any of those commands could write was Claude Code. So
 * `key mint --runtime codex --install` named Codex, wired Claude Code, and said nothing
 * — and the resulting failure surfaced as "signed in, but the server is unreachable",
 * which sends you to check a server that is fine and serving other clients.
 *
 * The commands that call this mint a key and write a KEY-BEARING entry, which is
 * deliberately per-folder and Claude-Code-only: a key must never be written into a
 * machine-global config (RTSC-91). So the honest answer is not to wire the named harness
 * here, it is to say that this command cannot and name the one that can.
 *
 * A note rather than a refusal. By the time this prints, the key is minted and the
 * Claude Code wiring is real work someone asked for; exiting would throw that away to
 * make a point. Silence was the bug, not the wiring.
 */
export function noteRuntimeIsALabel(runtime: string | undefined): void {
  const r = (runtime ?? "").trim();
  if (!r || r === "claude-code") return;
  console.log(
    `Note: --runtime ${r} sets this agent's LABEL in the Dash. It does not choose where\n` +
      `config is written. This command writes a key-bearing entry for THIS folder, and a\n` +
      `key only ever belongs in Claude Code's own config, never in a machine-wide one.\n` +
      `To wire ${r}, run \`retasc setup\` — secret-free, every harness, every folder.\n`,
  );
}

/**
 * Wire the Retasc MCP server into the user's agent. Prefers the `claude` CLI;
 * falls back to writing ./.mcp.json. Always prints the manual block so the user
 * can paste it into any other MCP client.
 */
export function installMcp(opts: { url: string; key: string; scope?: McpScope; watchdog?: boolean; install?: boolean }): void {
  const scope = opts.scope ?? "local";

  // Watchdog mode (RTSC-44): wire the stdio proxy so claims stay alive automatically.
  if (opts.watchdog) {
    // Only the stdio forms spawn a command; the plain HTTP entry below carries a URL and
    // needs nothing installed, so resolving is scoped to the branch that depends on it.
    const resolved = resolveLauncher({ version: VERSION, install: opts.install });
    const note = launcherNote(resolved);
    if (note) console.log(note);
    const res = tryClaudeCliWatchdog(opts.url, opts.key, scope, resolved.launcher);
    if (res.ok) {
      console.log(`✓ Registered Retasc with the liveness watchdog (stdio proxy, scope: ${scope}).`);
    } else {
      const path = writeProjectMcpJson(mcpProxyEntry(opts.url, opts.key, resolved.launcher));
      console.log(`✓ Wrote watchdog MCP config to ${path}`);
      console.log(`  ${fallbackNote(res)}`);
    }
    console.log("\nWatchdog MCP config (Codex / OpenCode / any stdio MCP client):\n");
    console.log(mcpProxyConfigBlock(opts.url, opts.key, resolved.launcher));
    // RTSC-646: the old text stopped at "no per-claim heartbeats", which reads as
    // "a claim never lapses while I'm working". It renews the claims THIS proxy saw
    // you make, for as long as it is running — so name both bounds here, or the
    // first surprise is the reclaimer taking an issue mid-build.
    console.log(
      "\nThe watchdog keeps claims alive automatically — it renews every claim it saw this session make, about every 10 minutes, so your agent needs no per-claim heartbeats. Long builds and test runs do NOT free a claim by themselves, and neither does a /clear: in Claude Code the new conversation is told which claims the window still holds, so it can carry on or release them.",
    );
    console.log(
      "Two things it does not cover, both safe (they fall back to the normal lease timeout: 30 minutes, or 2 hours for a claim made with no watchdog): if the proxy stops, renewal stops; and a claim made elsewhere — another terminal, direct HTTP MCP, or a previous proxy before a restart — is renewed by nobody. Heartbeat or checkpoint those yourself.",
    );
    return;
  }

  // RTSC-859 — this is the direct HTTP form, no watchdog, which is exactly a HOSTED
  // deployment's shape. It is the correct config for one (RTSC-864 documents it), and it
  // is NOT deprecated. But the key it wires does not know what it is for unless it was
  // minted `--hosted`, and a workspace key used this way is told on every claim to go
  // and wire the watchdog it is deliberately running without. Say so once, here, where
  // the choice is being made, rather than warning on every claim afterwards.
  console.log(
    "\nNo watchdog: nothing on a machine will renew this key's claims. If this key runs " +
      "from a cloud agent or CI, mint it with `retasc key mint --hosted` so Retasc knows " +
      "and stops advising it to run `bind`; a hosted key is expected to heartbeat itself.",
  );
  const res = tryClaudeCli(opts.url, opts.key, scope);
  if (res.ok) {
    console.log(`✓ Registered MCP server "${SERVER_NAME}" with Claude Code (scope: ${scope}).`);
  } else {
    const path = writeProjectMcpJson(mcpServerEntry(opts.url, opts.key));
    console.log(`✓ Wrote MCP config to ${path}`);
    console.log(`  ${fallbackNote(res)}`);
  }

  console.log("\nMCP config block (for any other agent/client):\n");
  console.log(mcpConfigBlock(opts.url, opts.key));
  console.log(`\nYour agent can now reach Retasc at ${opts.url}.`);
}

/**
 * Clear a credential-less placeholder that would SHADOW the marker we are about to write
 * (RTSC-691).
 *
 * Only ever removes an entry `isPlaceholderEntry` recognises — a bare URL with no
 * credential — and only from the scope we are NOT writing to. Writing our own scope
 * overwrites in place, so there is nothing to clean there.
 *
 * Removal goes through `claude mcp remove`, never by editing `~/.claude.json` ourselves.
 * That file is rewritten constantly by a running Claude Code, so a read-modify-write from
 * here would race it and could drop unrelated servers. Best-effort throughout: failing to
 * tidy a placeholder must never fail a bind that otherwise succeeded, and `doctor`
 * already reports a shadowed binding if one survives.
 */
function clearShadowingPlaceholder(scope: McpScope): void {
  const dir = process.cwd();
  // We wrote claude-local, so a folder placeholder is now harmless (local wins). We wrote
  // the folder, so a claude-local placeholder would take every call — that is the one to
  // clear.
  if (scope === "local") return;
  if (!hasClaudeLocalPlaceholder(dir)) return;
  const r = spawnSync("claude", ["mcp", "remove", "retasc", "-s", "local"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    console.log(
      "  Note: a credential-less `retasc` entry is still registered in Claude Code's local scope\n" +
        "  and will shadow this one. Remove it with `claude mcp remove retasc -s local`.",
    );
    return;
  }
  console.log("✓ Removed the placeholder `retasc` entry that would have shadowed this binding.");
}


/**
 * RTSC-92: wire the SECRET-FREE watchdog marker into this folder. The key lives
 * in the home keystore under `workspaceId`; this writes only the pointer (env
 * RETASC_WORKSPACE). Prefers the `claude` CLI, falls back to ./.mcp.json.
 */
export function installMarker(opts: {
  workspaceId: string;
  scope?: McpScope;
  install?: boolean;
  /**
   * A launcher already resolved (and announced) by the caller.
   *
   * RTSC-492: `join` has to make `retasc` durable BEFORE it mints a key, because a global
   * install can take tens of seconds and can fail, and neither should happen after we've
   * committed a key server-side. It resolves once, up front, and hands the result here so
   * this doesn't run the whole install ladder a second time. Callers with nothing to
   * sequence (bind's own path, `mcp install`) omit it and get the resolve below.
   */
  launcher?: Resolved;
  /** RTSC-673 — the caller renders its own summary (bind's receipt card). */
  quiet?: boolean;
}): { where: string; wroteFile: boolean } {
  const scope = opts.scope ?? "local";
  // RTSC-493: resolve BEFORE writing anything. The marker names a command something else
  // will spawn later, so it has to name one that has been proved to run on this machine.
  const resolved = opts.launcher ?? resolveLauncher({ version: VERSION, install: opts.install });
  // Only announce a resolve we did ourselves — a caller that passed one in already printed
  // its note at the point in ITS sequence where the install actually happened.
  const note = opts.launcher ? null : launcherNote(resolved);
  if (note) console.log(note);
  // `local` scope lands in this machine's own Claude config, where the absolute path is
  // both correct and fastest. `project` scope, and the ./.mcp.json fallback below, are
  // SHARED — a path under this user's home directory would leak their username into a
  // committed file and break every teammate who clones it. See portableLauncher.
  const shared = portableLauncher(resolved, VERSION);
  const res = tryClaudeCliMarker(
    opts.workspaceId,
    scope,
    scope === "project" ? shared : resolved.launcher,
  );
  if (res.ok) {
    if (!opts.quiet) console.log(`✓ Registered Retasc watchdog (secret-free marker, scope: ${scope}).`);
    clearShadowingPlaceholder(scope);
    return { where: `Claude Code (${scope})`, wroteFile: false };
  }
  // Always ./.mcp.json, whatever scope was asked for, so always the shared form.
  const path = writeProjectMcpJson(mcpMarkerEntry(opts.workspaceId, shared));
  // We just wrote the folder marker, whatever scope was asked for, so a claude-local
  // placeholder would now outrank it.
  clearShadowingPlaceholder("project");
  if (!opts.quiet) {
    console.log(`✓ Wrote secret-free watchdog marker to ${path}`);
    console.log(`  ${fallbackNote(res)}`);
  }
  return { where: path, wroteFile: true };
}

/**
 * Remove the retasc entry from this folder's ./.mcp.json (RTSC-721).
 *
 * The inverse of `writeProjectMcpJson`, and just as narrow: it deletes ONLY the
 * `retasc` server entry and leaves everything else — other servers, unknown keys —
 * byte-for-byte where it was. If retasc was the last entry the file still stays,
 * empty of servers, because deleting a file the user may have hand-edited is a
 * bigger act than we were asked to perform.
 *
 * Returns whether anything was actually removed, so the caller's receipt reports
 * what happened rather than what was attempted.
 */
export function removeProjectMarker(dir: string): boolean {
  const path = join(dir, ".mcp.json");
  if (!existsSync(path)) return false;
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false; // unparseable is not ours to rewrite
  }
  if (!doc?.mcpServers?.[SERVER_NAME]) return false;
  delete doc.mcpServers[SERVER_NAME];
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return true;
}

/**
 * Ask Claude Code to drop its own retasc entry, best effort (RTSC-721).
 *
 * The marker may live in claude-local scope rather than ./.mcp.json (that scope WINS at
 * runtime, which is exactly why it must not be left behind). `claude mcp remove` is the
 * only sanctioned way to edit that config. Absent `claude`, or a failure, is reported,
 * not thrown — unbind must finish its local work even where Claude Code is not installed.
 */
export function tryClaudeCliRemove(): boolean {
  try {
    const r = spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "local"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * The MCP config block, printed ONLY when we could not write it anywhere (RTSC-673).
 *
 * It exists for someone wiring a client we do not know how to configure, and that is a
 * real case. It is not the case where we just wrote the identical content to
 * `.mcp.json` for them — there it was fourteen lines instructing a person to perform a
 * job already finished, at the end of the one screen that should have said what to do
 * next. `retasc doctor` prints it on demand for anyone who does need it.
 */
export function printMarkerBlock(workspaceId: string, launcher?: Resolved): void {
  const shared = portableLauncher(launcher ?? resolveLauncher({ version: VERSION, install: false }), VERSION);
  console.log("\nMarker block (any stdio MCP client) — no secret, safe to commit:\n");
  console.log(mcpMarkerConfigBlock(workspaceId, shared));
  console.log("\nThe key lives in your home keystore (~/.retasc/bindings.json), not in the repo.");
}
