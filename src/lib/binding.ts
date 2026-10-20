import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getBinding } from "./keystore.js";
import { parseToolResult } from "./toolresult.js";

// RTSC-91/92 (DESIGN §13): read the per-folder Retasc binding. The canonical
// form (RTSC-92) is a SECRET-FREE marker carrying only a workspace id — the key
// is resolved from the home keystore. Legacy inline-key markers (RTSC-44/91) are
// still read so existing workspaces keep working until re-bound.
//
// RTSC-262: a folder's binding lives in ONE of two places, and both are legal:
// ./.mcp.json (Claude Code "project" scope) or Claude Code's own config under
// projects[dir] ("local" scope). Local is what `claude mcp add` writes by
// DEFAULT — see normalizeScope in commands/mcp.ts — so it is the common case,
// not an edge case. Reading only ./.mcp.json made `doctor` report "not bound"
// about a binding that was connected and working.
//
// Precedence when BOTH exist: claude-local wins, because that is what Claude
// Code itself runs (documented scope hierarchy: local > project > user; the
// whole entry is taken from the winner, no merging). The CLI must report the
// binding the agent ACTUALLY uses — confidently naming the shadowed org is
// exactly the cross-org confusion doctor exists to catch. Doctor surfaces the
// shadowed folder marker separately (readShadowedBinding).

/** Where a binding was found. folder/claude-local are per-folder and equally
 *  valid; global is the top-level (user-scope) form, illegal under §13. */
export type BindingSource = "folder" | "claude-local" | "global";

export type LocalBinding = {
  key: string;
  url: string;
  watchdog: boolean;
  source: BindingSource;
  workspaceId?: string; // present for the keystore-backed (secret-free) form
  legacy?: boolean; // true when the key is inlined in the config (pre-RTSC-92)
  markerOnly?: boolean; // marker present but no key resolved (needs `retasc bind`)
  // RTSC-493: what the MCP client will actually SPAWN, for the stdio forms. Carried so
  // doctor can check it resolves — a marker naming a command this machine doesn't have
  // is invisible until an agent tries to start, and then it fails somewhere else
  // entirely. Absent for the HTTP form, which spawns nothing.
  command?: string;
  args?: string[];
};

/** Claude Code's config file. RETASC_CLAUDE_CONFIG overrides it (tests). */
export function claudeConfigPath(): string {
  return process.env.RETASC_CLAUDE_CONFIG || join(homedir(), ".claude.json");
}

// "absent" and "unparseable" are different facts: an absent config proves no
// global server; a corrupt one proves nothing, and a safety check must never
// print an all-clear off a failed read (~/.claude.json is rewritten constantly,
// so a truncated write is a realistic state, not a corner case).
function readJson(path: string): { doc?: any; corrupt: boolean } {
  if (!existsSync(path)) return { corrupt: false };
  try {
    return { doc: JSON.parse(readFileSync(path, "utf8")), corrupt: false };
  } catch {
    return { corrupt: true };
  }
}

/** Turn a raw MCP server entry into a binding. Shared by all sources — the
 *  entry shape is identical wherever it is stored (see commands/mcp.ts). */
function parseServerEntry(s: any, source: BindingSource): LocalBinding | undefined {
  if (!s) return undefined;

  // Canonical (RTSC-92): secret-free marker → resolve the key from the keystore.
  // RTSC-493: the spawned command, when this is one of the stdio forms.
  const spawn = typeof s.command === "string"
    ? { command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [] }
    : {};

  const workspaceId: string | undefined = s.env?.RETASC_WORKSPACE;
  if (workspaceId) {
    const entry = getBinding(workspaceId);
    if (entry) return { key: entry.key, url: entry.url, watchdog: true, workspaceId, source, ...spawn };
    // Marker present but no keystore entry (e.g. a cloned repo) → needs binding.
    return { key: "", url: "", watchdog: true, workspaceId, markerOnly: true, source, ...spawn };
  }

  // Legacy inline-key forms (pre-RTSC-92): key in env or the Authorization header.
  if (s.env?.RETASC_MCP_KEY) {
    return {
      key: String(s.env.RETASC_MCP_KEY),
      url: String(s.env.RETASC_MCP_URL ?? ""),
      watchdog: true,
      legacy: true,
      source,
      ...spawn,
    };
  }
  const auth = s.headers?.Authorization ?? s.headers?.authorization;
  if (auth) {
    const m = String(auth).match(/^Bearer\s+(.+)$/i);
    return { key: m ? m[1].trim() : String(auth).trim(), url: String(s.url ?? ""), watchdog: false, legacy: true, source };
  }
  // An entry EXISTS but matches no shape we know. It still shadows lower scopes
  // at runtime (Claude Code runs it regardless), so returning undefined here
  // would let readLocalBinding fall back to a folder marker the agent is NOT
  // using — the confident-wrong-org failure this module exists to prevent.
  // Report presence without a key; doctor words it as "can't read a key".
  return { key: "", url: "", watchdog: false, markerOnly: true, source };
}

/** The raw folder-scope (./.mcp.json) retasc entry, if any. */
function folderEntry(dir: string): any | undefined {
  return readJson(join(dir, ".mcp.json")).doc?.mcpServers?.retasc;
}

/** The raw Claude-Code-local-scope retasc entry for a folder, if any.
 *  Exported so the shared key resolver (claim.ts resolveMcpConn) sees the same
 *  binding this module does — keeping doctor/whoami and claim/tidy/done in
 *  lockstep (RTSC-98's "one place" rule extends to entry SELECTION too). */
export function claudeLocalRetascEntry(dir: string): any | undefined {
  const projects = readJson(claudeConfigPath()).doc?.projects;
  if (!projects) return undefined;
  const direct = projects[dir]?.mcpServers?.retasc;
  if (direct) return direct;
  // Claude Code's projects key derivation is undocumented (raw cwd vs realpath,
  // trailing slash). Cheap insurance: retry with both sides path-normalized —
  // worst case it misses and we fail safe to "not bound", never to a wrong match.
  const norm = (p: string) => {
    const stripped = p.replace(/\/+$/, "") || "/";
    try {
      return realpathSync(stripped);
    } catch {
      return stripped;
    }
  };
  const want = norm(dir);
  for (const k of Object.keys(projects)) {
    // Only keys that actually CARRY a retasc entry are candidates — this both
    // avoids an early return on an empty match (a trailing-slash twin with no
    // entry must not mask a symlink twin that has one) and shrinks the
    // realpathSync surface to the handful of retasc-bearing keys. First
    // carrying match wins (deterministic per file order).
    const e = projects[k]?.mcpServers?.retasc;
    if (!e || k === dir) continue;
    if (norm(k) === want) return e;
  }
  return undefined;
}

/**
 * Was this resolveBinding failure the SERVER refusing the key, or the network failing us
 * (RTSC-721)?
 *
 * The difference decides whether a binding may be treated as DEAD. Every path in
 * `resolveAuth` that declines a caller throws `UNAUTHORIZED: ...` (RTSC-703 pinned that),
 * and that text rides back through the MCP error content into resolveBinding's throw. A
 * network outage, a 5xx, or a timeout produces anything BUT that word.
 *
 * Matching narrowly matters more than matching completely: clearing a binding on a
 * misread network blip would destroy a healthy credential to fix a problem the machine
 * does not have. A refusal we fail to recognise merely falls back to the cautious
 * "Replace it?" path, which is where every failure landed before this existed.
 *
 * NOT `isAuthError` from api.ts — that matcher looks for "unauthenticated"/OIDC shapes
 * from the SESSION layer and does not match the MCP surface's "UNAUTHORIZED".
 */
export function bindingRefused(e: unknown): boolean {
  return /\bUNAUTHORIZED\b/i.test(String((e as any)?.message ?? e));
}

/**
 * A failure that says nothing about the key: see `isNetworkError`.
 *
 * Every caller of `resolveBinding` splits its failures two ways, and the split decides
 * what the human is told to do. These three are neither a refusal nor a dead network,
 * so they are tagged explicitly instead of being classified by accident.
 */
function noVerdict(message: string): Error {
  const e = new Error(message);
  (e as any).retascNoVerdict = true;
  return e;
}

/** Read the Retasc binding a folder's agent actually uses, from either legal
 *  location — claude-local first, matching Claude Code's runtime precedence. */
export function readLocalBinding(dir: string): LocalBinding | undefined {
  const fromLocal = parseServerEntry(claudeLocalRetascEntry(dir), "claude-local");
  if (fromLocal) return fromLocal;
  return parseServerEntry(folderEntry(dir), "folder");
}

/** The LOSING per-folder binding when a folder is bound in both places (the
 *  ./.mcp.json marker shadowed by a claude-local entry). Doctor warns when the
 *  two identities differ, so a stale committed marker can't mislead a team. */
export function readShadowedBinding(dir: string): LocalBinding | undefined {
  if (!claudeLocalRetascEntry(dir)) return undefined;
  return parseServerEntry(folderEntry(dir), "folder");
}

/**
 * Is this a PLACEHOLDER entry — a bare URL with no credential of any kind (RTSC-691)?
 *
 * RTSC-678's flow starts by pointing the client at `https://mcp.retasc.com/mcp` with
 * nothing else in it, so the server can answer the handshake with setup instructions.
 * That entry is not a binding: it cannot authenticate, and every tool call through it
 * fails. It exists to be replaced by the real one `bind` writes.
 *
 * It has to be recognised so it can be REMOVED, because scope precedence would otherwise
 * make it win. `claude mcp add -t http` writes Claude-local scope by default; a `bind
 * --scope project` writes `./.mcp.json`; and claude-local beats the folder marker at
 * runtime (see the precedence note at the top of this file). Left in place, the finished
 * setup would sit in a file nothing reads while the credential-less entry took every
 * call — a setup that looks done and works nowhere.
 *
 * Deliberately narrow: a `url` and NO `command`, no env credential, no Authorization
 * header. Anything carrying a credential, or spawning something, is somebody's real
 * configuration and is never silently removed.
 */
export function isPlaceholderEntry(raw: any, knownUrls: string[] = PLACEHOLDER_URLS): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (typeof raw.url !== "string" || raw.url.length === 0) return false;
  if (typeof raw.command === "string") return false;
  if (raw.env && Object.keys(raw.env).length > 0) return false;
  // ANY header, not just Authorization. A gateway that injects credentials under some
  // other name is still somebody's real configuration.
  if (raw.headers && Object.keys(raw.headers).length > 0) return false;
  // And it must be the bootstrap URL we ourselves tell people to paste. This is the
  // clause that matters: Claude Code stores MCP OAuth tokens OUTSIDE the server entry,
  // keyed by server name, so a fully authorized OAuth binding is byte-identical to a
  // placeholder by shape alone. RTSC-678 — this issue's parent — is about adding exactly
  // that OAuth door, so shape-only matching would have grown a way to silently delete a
  // working binding at the moment we shipped one.
  return knownUrls.includes(normalizeUrl(raw.url));
}

/** The bare URLs we hand out for bootstrapping, normalized. */
const PLACEHOLDER_URLS = ["https://mcp.retasc.com/mcp"];

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").toLowerCase();
}

/** Is there a placeholder in Claude Code's LOCAL scope for this folder? */
export function hasClaudeLocalPlaceholder(dir: string): boolean {
  return isPlaceholderEntry(claudeLocalRetascEntry(dir));
}

/** Outcome of the illegal-global check. "present" means a top-level entry
 *  EXISTS — detection here is by presence, not by whether a key can be parsed
 *  out. Whether a present entry is a FAULT is a separate judgement, made by
 *  `globalVerdict` in commands/doctor.ts (RTSC-878): the one legal global entry
 *  is the identity-free `auto` marker that `retasc setup` writes.
 *  "unreadable" means the config exists but can't be parsed: no all-clear.
 *
 *  `raw` is the entry AS WRITTEN, carried because the parsed `LocalBinding` is
 *  lossy in exactly the way that judgement needs: `parseServerEntry` takes the
 *  `RETASC_WORKSPACE` branch BEFORE it looks at a key in a header or in
 *  `RETASC_MCP_KEY`, so an entry combining the `auto` sentinel with a real
 *  credential parses as an innocent keyless marker. Judging the parse alone
 *  would let that shape claim the exemption. */
export type GlobalCheck =
  | { status: "none" }
  | { status: "unreadable" }
  | { status: "present"; binding?: LocalBinding; raw?: unknown };

/** A user-scope (global) Retasc server: top-level in Claude Code's config,
 *  NOT under projects[dir]. Illegal under DESIGN §13 override #1 — it applies
 *  to every folder that has no binding of its own, so issues can land in the
 *  wrong project. `retasc bind` refuses to create one (normalizeScope); this
 *  catches one added by hand with `claude mcp add -s user`. */
export function readGlobalBinding(): GlobalCheck {
  const { doc, corrupt } = readJson(claudeConfigPath());
  if (corrupt) return { status: "unreadable" };
  const raw = doc?.mcpServers?.retasc;
  if (!raw) return { status: "none" };
  return { status: "present", binding: parseServerEntry(raw, "global"), raw };
}

export type Binding = {
  member: { name: string; isAgent: boolean; runtime?: string; principal?: string; session?: string };
  org: { name: string; slug: string };
  project: { prefix: string; name: string };
};

/** Two per-folder bindings are the SAME binding if they agree on workspace id
 *  (canonical form) or on the literal key (legacy forms). Anything else — or
 *  not enough identity to compare — is a disagreement worth surfacing. */
export function sameIdentity(a: LocalBinding, b: LocalBinding): boolean {
  if (a.workspaceId && b.workspaceId) return a.workspaceId === b.workspaceId;
  if (a.key && b.key) return a.key === b.key;
  return false;
}

/** True when resolveBinding failed WITHOUT delivering a verdict on the key —
 *  the server was unreachable, timed out, threw 5xx, or rate-limited us. The
 *  advice differs: "check your network / try again" vs "re-run retasc bind".
 *  A 4xx (other than 429) IS a verdict: the server saw the key and said no. */
export function isNetworkError(e: any): boolean {
  // Tagged rather than matched on its prose. `noVerdict` marks the failures where
  // something answered but not Retasc, or Retasc answered in a shape we could not
  // read: the server passed no judgement on the key either way. Without this they
  // fall through to the 4xx branch and `doctor` says "key not accepted, re-run
  // `retasc bind`" at somebody whose real problem is a proxy, which is both wrong
  // and the most expensive wrong answer available (a re-bind mints a new key).
  // A FLAG, not a regex, because this file's own comment is right that matching
  // prose is fragile, and these strings are copy that will be reworded.
  if (e?.retascNoVerdict === true) return true;
  const name = String(e?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError") return true;
  const msg = String(e?.message ?? e);
  const status = msg.match(/^MCP server returned (\d{3})$/);
  if (status) return Number(status[1]) >= 500 || Number(status[1]) === 429;
  return /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg);
}

/** Resolve a key's org/project by calling the MCP `whoami` tool (server-enforced
 * scope — the same banner the agent sees). Throws on an invalid/revoked key.
 * Bounded: doctor is the tool people run when things are broken, so it must
 * never hang on a dead network (RTSC-262 review). */
export async function resolveBinding(url: string, key: string): Promise<Binding> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`MCP server returned ${res.status}`);
  // `res.json()` used to be called straight, so a 200 carrying a proxy's error page
  // (or a captive portal's sign-in form) failed with a JSON parser's complaint about
  // a `<`. Read the text and say what actually happened instead.
  const raw = await res.text();
  let body: any;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw noVerdict("a proxy or a VPN sign-in page answered instead of Retasc");
  }
  if (body?.error) throw new Error(body.error.message ?? "MCP error");
  const result = body?.result;
  if (result?.isError) throw new Error(result?.content?.[0]?.text ?? "key not accepted");
  const text = result?.content?.[0]?.text;
  if (!text) throw noVerdict("the server said nothing at all about this key");
  // Tolerant, and never a bare JSON.parse. This message is printed by `whoami` and
  // `doctor` — the two commands someone runs when things are already wrong — so a
  // "SyntaxError: Unexpected token … in JSON at position 42" here would answer a
  // person's "what is broken?" with a parser's internal state. The shared parser also
  // recovers a payload that arrived with prose after it (RTSC-142/143), which is the
  // regression that made this line worth hardening in the first place.
  const parsed = parseToolResult(body);
  if (parsed.kind === "raw") {
    throw noVerdict("the server's answer wasn't in a shape this CLI could read");
  }
  return parsed.value as Binding;
}
