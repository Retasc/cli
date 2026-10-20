// RTSC-780: the harness registry. One entry per MCP client we know how to wire.
//
// Before this file the CLI could wire exactly one harness: `installMcp`/`installMarker`
// spawned `claude mcp add` and, if that failed, wrote ./.mcp.json. Everything else got
// nothing, which is why Codex had never worked in any project on any machine. The only
// non-Claude binding that ever existed here was hand-written into ~/.grok/config.toml by
// an agent, machine-global with an inline API key — the exact cross-org leak `normalizeScope`
// refuses to allow for Claude Code.
//
// The entry we write is the `auto` marker (keystore.AUTO_WORKSPACE): no key, no workspace
// id, nothing folder-specific. That is what makes ONE write per harness enough for every
// project, and it is only safe because the harnesses verified below spawn stdio servers
// with cwd set to the project directory, so the proxy can resolve the folder itself.
//
// Adding a harness is one entry in HARNESSES. Deliberately NOT populated from theory:
// every entry here was checked against a real installation, and the check that gates
// admission is the cwd one — a harness whose stdio server does not start in the project
// directory cannot use the `auto` marker at all, because one global entry would then
// resolve every folder to the same wrong place, silently.
//
// Verified so far: Claude Code, Codex, Grok (RTSC-780), then Cursor, OpenCode and Gemini
// CLI (RTSC-793), each confirmed by wiring a probe server that logs process.cwd() and
// running the harness from two different directories. Windsurf and VS Code are NOT
// candidates: they are editors, not agent harnesses, and were dropped from RTSC-780's
// original map rather than left sitting in it forever.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeAtomic } from "./fsAtomic.js";

/**
 * The home directory harness configs are resolved under.
 *
 * `RETASC_HOME` overrides it, the same escape hatch `keystore.ts` gives with
 * `RETASC_DIR` and for the same reason: without one, anything that exercises this
 * module writes into the developer's REAL global agent configs. That is not
 * hypothetical — it happened while building this, and the tell was `retasc setup`
 * reporting "replaced" on a Codex config that had never held a retasc entry.
 * A test that can silently reconfigure the machine it runs on is a worse bug than
 * whatever it was testing.
 */
function home(): string {
  return process.env.RETASC_HOME || homedir();
}

/** `/Users/me/.codex/config.toml` → `~/.codex/config.toml`, for receipts. The card's
 *  value column is 20 columns wide, and an absolute path ellipses away to nothing
 *  useful exactly where the reader is checking WHICH file we touched. */
export function tildePath(p: string): string {
  const h = home();
  return p.startsWith(h + "/") ? `~${p.slice(h.length)}` : p;
}

/** The stdio server entry to wire, already resolved to a runnable command. */
export type HarnessEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type InstallOutcome =
  /** Wired. `path` is where it landed, for the receipt. */
  | { ok: true; path: string; replaced: boolean }
  /** Present but we could not write. `reason` is shown to the human verbatim. */
  | { ok: false; reason: string };

export type Harness = {
  /** Stable slug, also what `--only` matches. */
  id: string;
  /** How a human refers to it. */
  label: string;
  /** Where its config lives, for the receipt. Not necessarily existing yet. */
  configPath(): string;
  /** Is this harness on the machine at all? Never writes. */
  detect(): boolean;
  /** Wire `entry`, replacing any existing retasc entry. */
  install(entry: HarnessEntry): InstallOutcome;
  /**
   * Every directory this harness could load the Retasc Agent Skill from, given this
   * machine and this working directory (RTSC-855). Read-only: nothing here installs a
   * skill, `lib/skill.ts` only looks.
   *
   * A list, not one path, because there are three real install routes and they land in
   * three different places: global (`-g`), project (the installer's DEFAULT), and, for
   * Claude Code, a plugin's own `skills/` folder. Each one is a skill the agent really
   * loads, so a check that knew about only one would tell people who followed our own
   * instructions that they had not, and send them to install it again.
   */
  skillDirs(): string[];
};

// --- skills directories -----------------------------------------------------
//
// Not derived from theory, same rule as the rest of this registry: every path below is a
// directory the `skills` installer (agentskills.io, the tool `SKILL_INSTALL_CMD` runs)
// reads for that harness, taken from its published agent table rather than guessed at. If
// a harness ever grew a convention we could not verify, the honest entry would be an empty
// list. "We do not know where yours lives" is a finding a human can act on, a made-up path
// is not.
//
// TWO scopes, because the installer has two and defaults to the one a global-only check
// would never see (`installGlobally = options.global ?? false`, and its interactive prompt
// offers Project first). A check that read only the home directory would call the skill
// missing for everybody who ran the install command exactly as printed, forever.
//
// The harness's own home variable is honoured here even though `configPath()` does not
// honour it. That asymmetry is deliberate: this path only READS, so resolving the same
// home the harness itself resolves can at worst find the skill somewhere true, whereas
// `configPath()` WRITES and shares its answer with subprocesses. RETASC_HOME still
// outranks everything, exactly as in `opencodeConfig()`, or the test override would stop
// protecting the developer's real home the moment one of these variables is set.

/** A harness's own config home: the test override first, then its documented variable,
 *  then the default under `~`. */
function harnessHome(envVar: string, dir: string): string {
  if (process.env.RETASC_HOME) return join(home(), dir);
  return process.env[envVar]?.trim() || join(home(), dir);
}

/** `<global skills dir>` plus the project-scope folder this harness reads in the working
 *  directory. Both are real install targets, so both answer "is the skill here". */
function skillDirs(globalDir: string, projectDir: string): string[] {
  return [globalDir, join(process.cwd(), ...projectDir.split("/"))];
}

export const SERVER_NAME = "retasc";

// --- shared helpers ---------------------------------------------------------

/**
 * True when `bin` resolves on PATH.
 *
 * This DOES run a shell (`command -v` is a shell builtin, not an executable), so the
 * argument is concatenated into a command string and a name carrying `;` or a space
 * would be a command injection. Every caller passes a literal from HARNESSES below,
 * but "the only caller today is safe" is how that stops being true, so the shape of
 * the name is checked here rather than trusted.
 */
export function onPath(bin: string): boolean {
  if (!/^[a-zA-Z0-9._-]+$/.test(bin)) return false;
  const r = spawnSync("command", ["-v", bin], { encoding: "utf8", shell: "/bin/sh" });
  return r.status === 0 && Boolean((r.stdout || "").trim());
}

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** Write, creating the parent directory. Config files can hold nothing secret by
 *  design (the marker is secret-free), so no 0600 dance is needed here — but we
 *  also never widen an existing file's mode, so an existing 0600 config stays 0600. */
function writeConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

// --- TOML (Codex, Grok) -----------------------------------------------------

/**
 * Splice one table (and its sub-tables) into a TOML document, in place.
 *
 * Deliberately textual rather than parse-and-reserialize. These are the user's own
 * global config files: they hold comments, hand-chosen ordering, and settings that
 * have nothing to do with us. A round-trip through a TOML parser would silently
 * rewrite all of that, and the CLI ships with two dependencies (commander, convex)
 * precisely so it stays cheap to install — adding a TOML library to reformat
 * somebody's config is the wrong trade twice over.
 *
 * Replaces every existing `[prefix]` / `[prefix.*]` table, then appends `block`.
 * A table ends at the next line that starts a different table at column 0.
 */
export function spliceTomlTable(text: string, prefix: string, block: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  const opens = (line: string): string | null => {
    const m = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    return m ? m[1].trim() : null;
  };
  for (const line of lines) {
    const table = opens(line);
    if (table !== null) {
      // A new table header always ends whatever we were skipping.
      skipping = table === prefix || table.startsWith(`${prefix}.`);
    }
    if (!skipping) out.push(line);
  }
  // Collapse the blank-line run the removal may have left at the end, so repeated
  // installs don't grow the file by one newline every time.
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  const body = out.join("\n");
  return `${body}\n\n${block.trim()}\n`;
}

/** The `[mcp_servers.retasc]` block, in the shape Codex and Grok both accept. */
export function tomlBlock(entry: HarnessEntry): string {
  const arr = entry.args.map((a) => JSON.stringify(a)).join(", ");
  const env = Object.entries(entry.env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("\n");
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${arr}]`,
    `enabled = true`,
    ``,
    `[mcp_servers.${SERVER_NAME}.env]`,
    env,
  ].join("\n");
}

/**
 * Which TOML spelling of "send this header" a harness reads (RTSC-864).
 *
 * There is no shared one, and the difference is not cosmetic. Verified against the
 * real binaries, each with its own config home so nothing on the machine was touched:
 *
 *     codex mcp get retasc --json   with `headers`      => http_headers: null
 *     grok  mcp list --json         with `http_headers` => no headers at all
 *
 * Both loads SUCCEED. Neither tool warns, errors, or mentions the key it ignored, so
 * pasting one dialect into the other yields a server that is configured, enabled, and
 * unauthenticated: a 401 at first tool call with nothing in the config that looks
 * wrong. That silence is why this is an argument rather than one block for both.
 */
export type TomlHttpDialect = "codex" | "grok";

/** The header table key each dialect actually reads. */
const HTTP_HEADER_TABLE: Record<TomlHttpDialect, string> = {
  codex: "http_headers",
  grok: "headers",
};

/**
 * The DIRECT-form `[mcp_servers.retasc]` block: talk to the remote MCP over HTTP with a
 * bearer key, no local process (RTSC-864).
 *
 * The TOML counterpart of `mcpConfigBlock`, and the block that did not exist: `tomlBlock`
 * above emits only the stdio proxy shape, so a Codex or Grok user on a host that cannot
 * spawn a process (claude.ai connectors, Codex Cloud, a hosted OpenCode) had nothing
 * correct to paste and no way to tell that from the JSON form.
 *
 * The key is written literally, exactly as the JSON block writes it, because the host
 * this is pasted into is the one that has no environment for us to read. Both tools can
 * take the key from the environment instead where there IS one (Codex:
 * `bearer_token_env_var = "RETASC_MCP_KEY"`; Grok expands `${RETASC_MCP_KEY}` inside a
 * header value), so prefer that, and never paste either form into a file the repo tracks.
 */
export function tomlHttpBlock(url: string, key: string, dialect: TomlHttpDialect): string {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${JSON.stringify(url)}`,
    `enabled = true`,
    ``,
    `[mcp_servers.${SERVER_NAME}.${HTTP_HEADER_TABLE[dialect]}]`,
    `Authorization = ${JSON.stringify(`Bearer ${key}`)}`,
  ].join("\n");
}

function tomlHarness(
  id: string,
  label: string,
  path: () => string,
  bin: string,
  skills: { home: string; dir: string; project: string },
): Harness {
  return {
    id,
    label,
    configPath: path,
    skillDirs: () => skillDirs(join(harnessHome(skills.home, skills.dir), "skills"), skills.project),
    detect: () => existsSync(path()) || onPath(bin),
    install(entry) {
      const p = path();
      const before = readIfExists(p);
      try {
        writeConfig(p, spliceTomlTable(before, `mcp_servers.${SERVER_NAME}`, tomlBlock(entry)));
      } catch (e) {
        return { ok: false, reason: String((e as any)?.message ?? e) };
      }
      return { ok: true, path: p, replaced: /^\s*\[\[?mcp_servers\.retasc\b/m.test(before) };
    },
  };
}

// --- JSONC (Cursor) ---------------------------------------------------------

// `~/.cursor/mcp.json` is named .json and is NOT parsed as JSON: cursor-agent reads a
// file containing `// comments` without complaint (verified against a real install,
// RTSC-793). So the same rule the TOML splice follows applies here — this is the user's
// own config, and a JSON.parse/JSON.stringify round-trip would silently delete every
// comment in it and reflow the rest.
//
// Hence a textual splice, and hence the small JSONC scanner below rather than a parser
// dependency. It only ever has to find one member and replace its value; everything it
// does not understand it steps over untouched, which is exactly the property we want
// from something editing a file we did not write.

/** Step over whitespace and JSONC comments, returning the next index that is neither. */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    return i;
  }
}

/** `i` points at the opening quote. Returns the index just past the closing quote. */
function endOfString(text: string, i: number): number {
  i++;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return i;
}

/** `i` points at the first character of a value. Returns the index just past it.
 *  Nesting is tracked so an object value containing commas ends in the right place. */
function endOfValue(text: string, i: number): number {
  i = skipTrivia(text, i);
  if (text[i] === '"') return endOfString(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i = endOfString(text, i); continue; }
      if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipTrivia(text, i); continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return i;
  }
  while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
  return i;
}

type Member = { name: string; start: number; valueStart: number; valueEnd: number };

/**
 * The members of the object whose `{` is at `open`, with the span of each value.
 *
 * `advance` is load-bearing, not defensive tidiness. `endOfValue` stops AT its
 * terminator set, so on a character already in that set (a stray `]`) it returns the
 * index it was handed, and a loop that trusted it would spin forever. That input is not
 * exotic: this parses a file a human hand-edits, and a dropped bracket is the ordinary
 * way one gets malformed. `retasc setup` hanging with no output, taking `bind` and the
 * whole of onboarding with it, is a far worse failure than any misparse — so every path
 * through this loop moves at least one character, and a document we cannot understand
 * ends as a document we scanned to the end of.
 */
function membersOf(text: string, open: number): { members: Member[] } {
  const members: Member[] = [];
  let i = open + 1;
  const advance = (next: number) => (next > i ? next : i + 1);
  for (;;) {
    i = skipTrivia(text, i);
    if (i >= text.length || text[i] === "}") return { members };
    if (text[i] === ",") { i++; continue; }
    if (text[i] !== '"') { i = advance(endOfValue(text, i)); continue; }
    const start = i;
    const keyEnd = endOfString(text, i);
    const name = text.slice(start + 1, keyEnd - 1);
    const j = skipTrivia(text, keyEnd);
    if (text[j] !== ":") { i = advance(keyEnd); continue; }
    const valueStart = skipTrivia(text, j + 1);
    const valueEnd = endOfValue(text, valueStart);
    members.push({ name, start, valueStart, valueEnd });
    i = advance(valueEnd);
  }
}

/** The first top-level `{`, or -1 if this document has no root object. */
function rootObject(text: string): number {
  const i = skipTrivia(text, 0);
  return text[i] === "{" ? i : -1;
}

/**
 * Put `value` at `mcpServers.<name>`, leaving every comment, every other server and
 * every unknown key exactly where they were.
 *
 * Three cases, in the order they are cheapest to be sure about: no usable document at
 * all (write a fresh one), a document with no `mcpServers` (insert the whole object),
 * and a document that already has one (replace our member's value, or insert it).
 */
export function spliceJsonServer(text: string, name: string, value: string): string {
  const indent = (s: string, by: string) => s.split("\n").join(`\n${by}`);
  const root = rootObject(text);
  if (root === -1) {
    return `{\n  "mcpServers": {\n    ${JSON.stringify(name)}: ${indent(value, "    ")}\n  }\n}\n`;
  }
  const { members } = membersOf(text, root);
  const servers = members.find((m) => m.name === "mcpServers");
  if (!servers) {
    const block = `"mcpServers": {\n    ${JSON.stringify(name)}: ${indent(value, "    ")}\n  }`;
    // A trailing comma is only correct if something follows; an empty root gets neither.
    const sep = members.length ? ",\n  " : "\n  ";
    const head = members.length ? text.slice(0, members[0].start) : text.slice(0, root + 1);
    const tail = members.length ? text.slice(members[0].start) : text.slice(root + 1);
    return members.length
      ? `${head}${block}${sep}${tail}`
      : `${head}${sep}${block}\n${tail}`;
  }
  // `mcpServers` present but not an OBJECT. Scanning on would treat the rest of the
  // document as its members and splice our entry one character into a number or a
  // string, writing a corrupt file over a config we were handed intact — the one
  // outcome this whole textual approach exists to prevent. We own this key, and a
  // non-object here is already meaningless to every harness that reads it, so replace
  // the value wholesale and leave the rest of the document alone.
  if (text[servers.valueStart] !== "{") {
    const fresh = `{\n    ${JSON.stringify(name)}: ${indent(value, "    ")}\n  }`;
    return text.slice(0, servers.valueStart) + fresh + text.slice(servers.valueEnd);
  }
  const inner = membersOf(text, servers.valueStart);
  const mine = inner.members.find((m) => m.name === name);
  if (mine) {
    return text.slice(0, mine.valueStart) + indent(value, "    ") + text.slice(mine.valueEnd);
  }
  const at = servers.valueStart + 1;
  const insert = `\n    ${JSON.stringify(name)}: ${indent(value, "    ")}${inner.members.length ? "," : ""}`;
  return text.slice(0, at) + insert + text.slice(at);
}

/** True when `mcpServers.<name>` is already present — the receipt's "updated" vs "new". */
export function hasJsonServer(text: string, name: string): boolean {
  const root = rootObject(text);
  if (root === -1) return false;
  const servers = membersOf(text, root).members.find((m) => m.name === "mcpServers");
  if (!servers || text[servers.valueStart] !== "{") return false;
  return membersOf(text, servers.valueStart).members.some((m) => m.name === name);
}

/** Our entry, in the shape Cursor reads: command + args + env. */
export function jsonServerValue(entry: HarnessEntry): string {
  return JSON.stringify({ command: entry.command, args: entry.args, env: entry.env }, null, 2);
}

// --- Claude Code ------------------------------------------------------------

/**
 * The `skills/` folder of every plugin Claude Code has installed (RTSC-855).
 *
 * `/plugin install retasc@retasc` is one of the three install routes our public skills
 * README offers, and it does NOT write into `~/.claude/skills`. The plugin is unpacked
 * under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and its skills are
 * read from there. So a check that only looked in the skills folder would tell exactly
 * the people who followed our own instructions that they had not.
 *
 * Read from the manifest rather than globbed, because the manifest is what Claude Code
 * itself acts on: a stale directory left behind by an uninstall is not an installed
 * skill, and enumerating the cache would count it as one. Best effort throughout, because
 * this feeds a nudge and a manifest we cannot parse must never become a hard failure in
 * `doctor`.
 */
function claudePluginSkillDirs(): string[] {
  try {
    const manifest = join(harnessHome("CLAUDE_CONFIG_DIR", ".claude"), "plugins", "installed_plugins.json");
    const parsed = JSON.parse(readIfExists(manifest) || "{}");
    const plugins = parsed?.plugins;
    if (!plugins || typeof plugins !== "object") return [];
    const dirs: string[] = [];
    for (const installs of Object.values(plugins as Record<string, unknown>)) {
      for (const i of Array.isArray(installs) ? installs : []) {
        // Absolute only. A relative `installPath` would resolve against the CURRENT
        // DIRECTORY, so running `retasc doctor` inside any repo that happens to contain
        // `skills/retasc/SKILL.md` (this one does) would report the skill installed.
        // Claude Code writes absolute paths, so nothing legitimate is dropped.
        // User scope only. A plugin installed for one project would otherwise make
        // `doctor` report the skill present in every OTHER folder, where the agent
        // cannot load it. A false "installed" is the worse error of the two: it
        // produces silence instead of the nudge this check exists to give.
        const scope = (i as any)?.scope;
        if (scope !== undefined && scope !== "user") continue;
        const p = (i as any)?.installPath;
        if (typeof p === "string" && isAbsolute(p)) dirs.push(join(p, "skills"));
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 * Claude Code is the one harness with a real CLI for this, and `claude mcp add` is
 * the ONLY sanctioned way to edit `~/.claude.json`: a running Claude Code rewrites
 * that file constantly, so a read-modify-write from here would race it and could
 * drop unrelated servers.
 *
 * Scope `user` here, which `normalizeScope` refuses everywhere else (RTSC-91). The
 * refusal is about a global entry that NAMES an org — an id or a key in a
 * machine-wide file routes every folder to one project. The `auto` marker names
 * nothing, so the objection does not apply to it, and the whole point of RTSC-780
 * is that this entry is written once and serves every folder.
 */
const claudeCode: Harness = {
  id: "claude-code",
  label: "Claude Code",
  configPath: () => join(home(), ".claude.json"),
  skillDirs: () => [
    ...skillDirs(join(harnessHome("CLAUDE_CONFIG_DIR", ".claude"), "skills"), ".claude/skills"),
    ...claudePluginSkillDirs(),
  ],
  // A test home means "do not touch this machine's real config". `claude mcp add`
  // writes ~/.claude.json wherever HOME points, so the override has to gate DETECTION,
  // not just the path: an undetected harness is never installed into.
  detect: () => !process.env.RETASC_HOME && onPath("claude"),
  install(entry) {
    const args = [
      "mcp", "add",
      SERVER_NAME,
      "--transport", "stdio",
      "--scope", "user",
      ...Object.entries(entry.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--", entry.command, ...entry.args,
    ];
    // An existing user-scope entry makes `add` fail rather than replace, so clear it
    // first. Best effort: a missing entry exits non-zero and that is fine.
    //
    // This does open a remove-then-fail window: if `add` fails after a successful
    // remove, the user is left with no retasc entry rather than the one they had. The
    // blast radius is bounded to OUR entry (the name is fixed, and `-s user` scopes it),
    // the outcome is reported rather than swallowed, and `retasc setup` re-runs cleanly.
    // Restoring the previous entry would mean reading ~/.claude.json ourselves, which is
    // the one thing that file must never have done to it: a running Claude Code rewrites
    // it constantly and the read-modify-write would race it.
    const had = spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], {
      encoding: "utf8",
    });
    const r = spawnSync("claude", args, { encoding: "utf8" });
    if (r.error) return { ok: false, reason: (r.error as Error).message };
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || "").trim().split("\n")[0] || `exited ${r.status}`;
      return { ok: false, reason: msg };
    }
    return { ok: true, path: "Claude Code (user scope)", replaced: had.status === 0 };
  },
};

// --- Cursor -----------------------------------------------------------------

/**
 * `cursor-agent`, NOT `cursor`.
 *
 * They are two different binaries and only one of them is a harness: `cursor` is the
 * VS Code-style IDE launcher (`--diff`, `--merge`, `--goto`), while `cursor-agent` is
 * the agent, and `cursor-agent mcp login` names `.cursor/mcp.json` or `~/.cursor/mcp.json`
 * as where it reads servers from. Detecting on `cursor` would report a harness we had
 * not wired anything usable into.
 *
 * The one adapter here that writes its own file: `cursor-agent mcp` offers login, list,
 * enable and disable, but no `add`.
 */
const cursor: Harness = {
  id: "cursor",
  label: "Cursor",
  configPath: () => join(home(), ".cursor", "mcp.json"),
  skillDirs: () => skillDirs(join(home(), ".cursor", "skills"), ".agents/skills"),
  detect: () => existsSync(join(home(), ".cursor")) || onPath("cursor-agent"),
  install(entry) {
    const p = join(home(), ".cursor", "mcp.json");
    const before = readIfExists(p);
    try {
      writeConfig(p, spliceJsonServer(before, SERVER_NAME, jsonServerValue(entry)));
    } catch (e) {
      return { ok: false, reason: String((e as any)?.message ?? e) };
    }
    return { ok: true, path: p, replaced: hasJsonServer(before, SERVER_NAME) };
  },
};

/**
 * Pi (RTSC-1154). Pi ships no MCP client: users add one, and the one everyone uses is
 * `pi-mcp-adapter`. It reads the project `.mcp.json` too, which is how Pi found Retasc
 * before this, but with its DEFAULT lifecycle: `"lazy"`, with a 10-minute `idleTimeout`.
 * An idle server is closed, which kills our watchdog, and every lease it was renewing
 * lapses while the agent is still working. So Pi gets its own entry, in its own override
 * file (`<agent dir>/mcp.json`), carrying `"lifecycle": "lazy-keep-alive"` (adapter
 * 2.12.0+): started on first use, then never closed for idleness. NOT `"keep-alive"`,
 * which starts the server when Pi starts, in every folder, before Pi has written its
 * session file, so the proxy would record the PREVIOUS session's transcript. The first
 * Retasc tool call is the first moment a watchdog has anything to renew anyway.
 *
 * The adapter merges servers field by field across its sources, so a project `.mcp.json`
 * that also defines `retasc` (with its workspace) still inherits the keep-alive from here;
 * and this file is Pi's, so no other harness reads the field. `detect` is Pi itself: the
 * entry is inert until the adapter is installed, and harmless.
 */
function piAgentDir(): string {
  // Expanded exactly as Pi and the adapter expand it (`~`, `~/…`, then resolved), and
  // refused unless that yields an absolute path: a relative value would otherwise put
  // Pi's config inside whatever folder we were started in, where Pi never looks.
  const raw = process.env.PI_CODING_AGENT_DIR?.trim();
  if (raw) {
    const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
    if (isAbsolute(expanded)) return resolve(expanded);
  }
  return join(home(), ".pi", "agent");
}

/** The retasc entry as Pi's adapter reads it: the usual one, kept alive. */
export const PI_LIFECYCLE = "lazy-keep-alive";

export function piServerValue(entry: HarnessEntry): string {
  return JSON.stringify({ command: entry.command, args: entry.args, env: entry.env, lifecycle: PI_LIFECYCLE }, null, 2);
}

/**
 * RTSC-1154 — make sure Pi keeps our watchdog alive, on a machine that was set up before
 * Pi had an entry. Called by a proxy Pi itself launched, so it runs exactly where it is
 * needed, and without anyone re-running `setup`. Leaves a kept-alive entry alone; never
 * rewrites a file it cannot parse.
 */
export function ensurePiKeepAlive(entry: () => HarnessEntry): "present" | "written" | "failed" {
  const p = join(piAgentDir(), "mcp.json");
  // Unattended, so it only ever ADDS. An existing `retasc` entry is someone's (a pinned
  // workspace, a launcher path, a lifecycle they chose): it gets `lifecycle` only when it
  // has none, and nothing else of it changes. No entry at all: ours, whole, which is what
  // `setup` writes for every other harness; with a lazy lifecycle it starts a proxy only
  // when a Retasc tool is used. `entry` is a thunk because resolving the launcher runs
  // processes, and the common case (already there) must not pay for it.
  if (!existsSync(p)) return pi.install(entry()).ok ? "written" : "failed";
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return "failed";
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "failed";
  const cur = doc.mcpServers?.[SERVER_NAME];
  if (!cur) return pi.install(entry()).ok ? "written" : "failed";
  if (typeof cur !== "object" || Array.isArray(cur)) return "failed";
  if (cur.lifecycle !== undefined) return "present";
  cur.lifecycle = PI_LIFECYCLE;
  try {
    writeAtomic(p, JSON.stringify(doc, null, 2) + "\n");
  } catch {
    return "failed";
  }
  return "written";
}

const pi: Harness = {
  id: "pi",
  label: "Pi",
  configPath: () => join(piAgentDir(), "mcp.json"),
  // Pi reads `.pi/skills` and `.agents/skills`; the installer's default is the latter.
  skillDirs: () => skillDirs(join(piAgentDir(), "skills"), ".agents/skills"),
  detect: () => existsSync(piAgentDir()) || onPath("pi"),
  install(entry) {
    const p = join(piAgentDir(), "mcp.json");
    const before = readIfExists(p);
    try {
      writeConfig(p, spliceJsonServer(before, SERVER_NAME, piServerValue(entry)));
    } catch (e) {
      return { ok: false, reason: String((e as any)?.message ?? e) };
    }
    return { ok: true, path: p, replaced: hasJsonServer(before, SERVER_NAME) };
  },
};

// --- harnesses with their own `mcp add` -------------------------------------

/**
 * OpenCode and Gemini both ship the thing Claude Code ships and Codex, Grok and Cursor
 * do not: a supported command for this. Each was checked against a real install
 * (RTSC-793) for the three properties that decide whether calling it beats writing the
 * file ourselves, and both have all three: it preserves comments and key order, it
 * leaves other servers and unknown keys alone, and re-adding the same name REPLACES
 * rather than failing (so `runSetup` on every bind stays idempotent).
 *
 * Given that, shelling out is strictly better than a serializer of ours: their config
 * format is theirs to change, and a format change breaks our writer silently while
 * their own command keeps working.
 *
 * `replaced` is read from the file rather than from what the command prints, so the
 * receipt does not depend on anybody's wording staying put.
 */
function addCommandHarness(opts: {
  id: string;
  label: string;
  bin: string;
  configPath: () => string;
  /** The project-scope skills folder this harness reads, relative to the cwd. */
  projectSkillDir: string;
  args: (entry: HarnessEntry) => string[];
}): Harness {
  return {
    id: opts.id,
    label: opts.label,
    configPath: opts.configPath,
    skillDirs: () => skillDirs(join(dirname(opts.configPath()), "skills"), opts.projectSkillDir),
    // Gated on RETASC_HOME for the same reason Claude Code is: this shells out to a
    // command that resolves the REAL home, so a test home has to stop it at DETECTION.
    // An undetected harness is never installed into.
    detect: () => !process.env.RETASC_HOME && onPath(opts.bin),
    install(entry) {
      const before = readIfExists(opts.configPath());
      const r = spawnSync(opts.bin, opts.args(entry), { encoding: "utf8" });
      if (r.error) return { ok: false, reason: (r.error as Error).message };
      if (r.status !== 0) {
        const msg = (r.stderr || r.stdout || "").trim().split("\n").pop() || `exited ${r.status}`;
        return { ok: false, reason: msg };
      }
      return {
        ok: true,
        path: opts.configPath(),
        replaced: before.includes(`"${SERVER_NAME}"`),
      };
    },
  };
}

/** `~/.config/opencode/`, XDG-aware — OpenCode honours XDG_CONFIG_HOME, so resolving it
 *  to `~/.config` unconditionally would name the wrong file in the receipt.
 *
 *  `RETASC_HOME` outranks XDG_CONFIG_HOME, which is the whole point of the override and the
 *  one thing this function used to get wrong: reading the environment first meant the escape
 *  hatch was ignored on every machine that sets XDG_CONFIG_HOME, so a test run wrote into the
 *  developer's REAL `~/.config/opencode/` — the exact accident `home()` exists to prevent, and
 *  invisible on macOS, which does not set the variable. Take the override first, then the
 *  environment, then the default. */
function opencodeConfig(): string {
  const xdg = process.env.RETASC_HOME
    ? join(home(), ".config")
    : process.env.XDG_CONFIG_HOME || join(home(), ".config");
  return join(xdg, "opencode", "opencode.jsonc");
}

/**
 * `opencode mcp add <name> --env K=V -- <command> <args...>`.
 *
 * The `--` is required: without a URL or a command after it, `add` refuses. Note the
 * stored shape is unlike every other harness here — the key is `mcp` rather than
 * `mcpServers`, it carries `"type": "local"`, `command` is ONE array of command plus
 * args, and env is spelled `environment`. A generic mcpServers writer would produce a
 * file OpenCode ignores, which is the other half of why this one shells out.
 */
const opencode = addCommandHarness({
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  configPath: opencodeConfig,
  projectSkillDir: ".agents/skills",
  args: (entry) => [
    "mcp", "add", SERVER_NAME,
    ...Object.entries(entry.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--", entry.command, ...entry.args,
  ],
});

/**
 * `gemini mcp add -s user -t stdio -e K=V <name> <command> <args...>`.
 *
 * Scope `user`, for the reason the whole marker exists: one entry, correct in every
 * folder. The default is `project`, which would write a `.gemini/` into whichever
 * directory `retasc setup` happened to run in.
 *
 * Two Gemini quirks, neither ours to fix but both worth knowing before someone reports
 * them as our bug. `gemini mcp list` reports a freshly added server as `Disabled` and
 * `gemini mcp enable <name>` answers `Server not found` for it — yet the server does
 * start and connect on a real run, so `list` is not a verification signal. And Gemini
 * gates on trusted folders: in an untrusted directory it refuses to start and NO MCP
 * server loads, which looks exactly like a failed install.
 */
const gemini = addCommandHarness({
  id: "gemini",
  label: "Gemini CLI",
  bin: "gemini",
  configPath: () => join(home(), ".gemini", "settings.json"),
  projectSkillDir: ".agents/skills",
  args: (entry) => [
    "mcp", "add",
    "-s", "user",
    "-t", "stdio",
    ...Object.entries(entry.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    SERVER_NAME, entry.command, ...entry.args,
  ],
});

// --- the registry -----------------------------------------------------------

export const HARNESSES: Harness[] = [
  claudeCode,
  tomlHarness("codex", "Codex", () => join(home(), ".codex", "config.toml"), "codex", {
    home: "CODEX_HOME",
    dir: ".codex",
    project: ".agents/skills",
  }),
  tomlHarness("grok", "Grok", () => join(home(), ".grok", "config.toml"), "grok", {
    home: "GROK_HOME",
    dir: ".grok",
    project: ".grok/skills",
  }),
  cursor,
  opencode,
  gemini,
  pi,
];

/** Every harness actually present on this machine. */
export function detectHarnesses(list: Harness[] = HARNESSES): Harness[] {
  return list.filter((h) => {
    try {
      return h.detect();
    } catch {
      return false;
    }
  });
}
