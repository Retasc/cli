// Pure helpers for `retasc claim` / `retasc next` (RTSC-38). Kept side-effect-free
// (no git, no process spawning) so the slug/branch/worktree-path derivation and the
// MCP-key resolution can be unit-tested. The git + shell work lives in
// ../commands/claim.ts.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeLocalRetascEntry } from "./binding.js";
import { resolveConn } from "./keystore.js";
import { clean } from "./text.js";
// Tool-payload extraction lives in the shared tolerant parser (RTSC-143);
// re-exported so existing importers of this module keep working.
import { toolResult } from "./toolresult.js";
export { toolResult };

/** Resolved Retasc MCP connection: where to call and the key to call with. */
export type McpConn = { url: string; key: string };

const DEFAULT_MCP_URL = "https://mcp.retasc.com/mcp";

/**
 * Resolve the agent API key + MCP URL the same way the workspace's MCP wiring does,
 * so `retasc claim` speaks as the *same agent* the harness already uses. Delegates
 * to the shared `resolveConn` (RTSC-98) so it stays in lockstep with the proxy —
 * covering explicit env, both legacy `.mcp.json` shapes, AND the canonical
 * secret-free marker (`RETASC_WORKSPACE` → home keystore). `key` comes back empty
 * if nothing is found, so the caller can error clearly.
 */
export function resolveMcpConn(
  opts: { env?: NodeJS.ProcessEnv; mcpJson?: unknown; defaultUrl?: string; dir?: string } = {},
): McpConn {
  // RTSC-262: the binding may live in Claude Code's local scope instead of
  // ./.mcp.json (the `claude mcp add` DEFAULT). Select the same entry the
  // runtime does — claude-local wins over the folder marker (local > project) —
  // so claim/tidy/done can never disagree with doctor/whoami about whether a
  // folder is bound. Explicit env (the proxy path) still wins inside resolveConn.
  const localEntry = claudeLocalRetascEntry(opts.dir ?? process.cwd());
  const { key, url } = resolveConn({
    env: opts.env,
    mcpEntry: localEntry ?? (opts.mcpJson as any)?.mcpServers?.retasc,
    defaultUrl: opts.defaultUrl || DEFAULT_MCP_URL,
  });
  return { url: url || DEFAULT_MCP_URL, key };
}

/** Read & parse the workspace `.mcp.json` (or null if absent/corrupt). */
export function readMcpJson(dir = process.cwd()): unknown {
  const p = join(dir, ".mcp.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Kebab-case slug for a branch name: lowercase, non-alphanumeric runs become a
 * single '-', trimmed and capped. Always returns something git-legal.
 */
export function slugFromTitle(title: string, max = 50): string {
  const slug = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "issue";
}

/**
 * Issue ids look like `RTSC-38` (prefix + number). The server is trusted, but the
 * id flows into a git ref and a filesystem path, so we validate its shape before
 * using it — a malformed id (containing `/`, `..`, a leading `-`, …) is rejected
 * rather than turned into a stray path or an injected git flag.
 */
export function isValidIssueId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id);
}

/**
 * Normalize a user-typed issue reference (`143`, `rtsc-143`, `RTSC-143`) to the
 * canonical `PREFIX-NN` form. A bare number needs `defaultPrefix` (from the
 * logged-in project) to be resolvable. Returns null when the input can't be an
 * issue id — the caller decides how to fail loudly (RTSC-148: a typo must never
 * silently fall through to `next_issue`).
 */
/**
 * The workspace's project prefix, asked of the server over the workspace's own
 * key (`whoami`). Org/project routing IS the key — the global config's prefix
 * may belong to a different workspace, so this is the authoritative source for
 * expanding a bare issue number. Best-effort: undefined on any failure.
 */
export async function workspacePrefix(
  conn: McpConn,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const who = (await mcpCall(conn, "whoami", {}, fetchImpl)) as any;
    const p = who?.project?.prefix;
    return typeof p === "string" && p ? p : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeIssueId(input: string, defaultPrefix?: string): string | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) {
    return defaultPrefix ? `${defaultPrefix.toUpperCase()}-${s}` : null;
  }
  return isValidIssueId(s) ? s.toUpperCase() : null;
}

export type WorktreePlan = { branch: string; path: string; dirName: string };

/**
 * Derive the branch + sibling worktree path from an issue, matching the CLAUDE.md
 * convention: branch `rtsc-NN/<slug>`, worktree dir `../<repo>-rtsc-NN`.
 */
export function planWorktree(opts: {
  issueId: string;
  title: string;
  repoName: string;
  parentDir: string;
}): WorktreePlan {
  const lc = opts.issueId.toLowerCase(); // "RTSC-38" → "rtsc-38"
  const branch = `${lc}/${slugFromTitle(opts.title)}`;
  const dirName = `${opts.repoName}-${lc}`;
  return { branch, dirName, path: resolve(opts.parentDir, dirName) };
}

export type ClaimResult = {
  issueId?: string;
  title?: string;
  claimToken?: string;
  /** Set on an empty next_issue so the caller can explain the stall. */
  ready?: number;
  blocked?: number;
  claimed?: number;
  /** RTSC-306: ready work stranded in another human's lane (lane-scoped pulls). */
  otherLanes?: number;
};

/**
 * Normalize a next_issue / claim_issue tool payload. next_issue returns a full
 * issue object (with title); claim_issue returns just the identifier string. An
 * empty next_issue returns {issue:null, ready, blocked, claimed}.
 */
export function parseClaimResult(result: unknown): ClaimResult {
  if (!result || typeof result !== "object") return {};
  const r = result as any;
  const issueId = typeof r.issue === "string" ? r.issue : r.issue?.id;
  // An empty next_issue (issue:null) — or any payload without a usable id — is a
  // stall, never a claim. Surface the queue counts so it's never silent.
  if (!issueId) {
    return { ready: r.ready, blocked: r.blocked, claimed: r.claimed, otherLanes: r.otherLanes };
  }
  const title = typeof r.issue === "object" ? r.issue?.title : undefined;
  return { issueId, title, claimToken: r.claimToken };
}


/**
 * A sentence a PERSON can act on for a non-2xx from the MCP endpoint.
 *
 * This path used to paste 200 characters of the raw body after the status, and the raw
 * body is the one shape a reader cannot use: from Convex it is a JSON-RPC envelope, and
 * when the failure happens at Cloudflare instead of in Convex it is a page of HTML. Both
 * land in the terminal of somebody who typed `retasc claim`, and neither says what to do.
 *
 * So the body is never printed. It is READ — for a message, if it carries one — and what
 * gets shown is what the status means, in words, plus the fix where there is one. The
 * status is kept, in parentheses, because it is the thing worth quoting in a bug report.
 *
 * Pure, and exported, so the wording is pinned by a test rather than by a live 401.
 */
export function mcpFailureMessage(status: number, body = "", url?: string): string {
  const said = bodyMessage(body);
  const why =
    status === 401 || status === 403
      ? "Retasc refused this folder's key. Re-run `retasc bind` here to mint a fresh one."
      : status === 404
        ? `Nothing is serving Retasc at ${url ? clean(url) : "that address"}. Check this folder's MCP url, or re-run \`retasc bind\`.`
        : status === 429
          ? "Retasc is rate-limiting this key. Wait a moment, then try again."
          : status >= 500
            ? "Retasc's server had a problem. Nothing was claimed or changed — try again in a minute."
            : "Retasc refused the request.";
  return `${why} (HTTP ${status}${said ? `: ${said}` : ""})`;
}

/**
 * The one sentence inside an error body, or nothing.
 *
 * Only ever returns text the server MEANT as a message — a JSON-RPC `error.message`, a
 * tool result's text, a bare `message` field. Anything else (HTML, a payload with no
 * message in it, a body that is not JSON at all) returns undefined, so the caller says
 * its own sentence rather than quoting a structure at the reader. Control characters are
 * stripped and it is capped at one line: this reaches a terminal that acts on escapes.
 */
function bodyMessage(body: string): string | undefined {
  if (!/^\s*[{[]/.test(body)) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const said = [parsed?.error?.message, parsed?.result?.content?.[0]?.text, parsed?.message].find(
    (c) => typeof c === "string" && c.trim(),
  );
  if (!said) return undefined;
  const line = clean(said).split("\n")[0].trim();
  // A "message" that is itself a payload is the very thing this function exists to keep
  // off the screen — a server can put its JSON result in `content[0].text`, and quoting
  // that back would reintroduce the blob one layer down.
  if (!line || /^[{[]/.test(line)) return undefined;
  return line.slice(0, 200);
}

/**
 * Call one MCP tool over JSON-RPC with the agent key. Throws on transport errors
 * and on tool errors (isError) — surfacing the server's message (CLAIM_LOST,
 * NOT_FOUND, ALREADY_CLAIMED, …) so the caller can print it verbatim.
 */
export async function mcpCall(
  conn: McpConn,
  name: string,
  args: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(conn.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  // A non-2xx (expired/invalid key → 401, server error → 5xx) must not look like
  // an empty queue — say what happened, in words. See mcpFailureMessage.
  if (!res.ok) throw new Error(mcpFailureMessage(res.status, text, conn.url));
  // A 200 whose body is not JSON is a captive portal, a proxy error page, or a
  // deployment answering on the wrong route. Letting JSON.parse throw puts
  // "Unexpected token < in JSON at position 0" in front of a person, which names
  // neither the problem nor the fix.
  let resp: unknown = null;
  if (text) {
    try {
      resp = JSON.parse(text);
    } catch {
      throw new Error(
        `${clean(conn.url)} answered, but not with Retasc's reply — something in between (a proxy, ` +
          `a captive portal, a VPN sign-in page) is intercepting it.`,
      );
    }
  }
  if ((resp as any)?.error) {
    throw new Error((resp as any).error?.message || "MCP transport error");
  }
  if ((resp as any)?.result?.isError) {
    const msg = (resp as any).result?.content?.[0]?.text || "tool error";
    throw new Error(msg);
  }
  return toolResult(resp);
}

/**
 * Resolve one user-typed issue reference to a canonical `PREFIX-NN`, expanding a bare
 * number against the WORKSPACE's prefix (RTSC-148), or explaining why it can't.
 *
 * Extracted for RTSC-709: `checkpoint`, `check-claim` and `issue show` all take the same
 * reference in the same forms, and `commands/claim.ts` had the only copy of the rule. The
 * `cache` is what keeps a two-reference call site (`claim 143 --id 143`) to a single
 * `whoami`, exactly as the inline version did.
 */
export type PrefixCache = {
  prefix?: string;
  resolved?: boolean;
  /** Last resort if the server can't be asked. Lazy: only a bare number ever needs it. */
  fallback?: () => string | undefined;
};

export async function resolveIssueRef(
  conn: McpConn,
  raw: string,
  cache: PrefixCache = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; error?: undefined } | { id?: undefined; error: string }> {
  const bare = /^\d+$/.test(raw.trim());
  if (bare && !cache.resolved) {
    cache.prefix = (await workspacePrefix(conn, fetchImpl)) ?? cache.fallback?.();
    cache.resolved = true;
  }
  const norm = normalizeIssueId(raw, cache.prefix);
  if (norm) return { id: norm };
  if (bare && !cache.prefix) {
    return {
      error:
        `"${raw}" is a bare number and the project prefix couldn't be resolved from this workspace.\n` +
        `  Use the full id (e.g. RTSC-${raw.trim()}).`,
    };
  }
  return { error: `"${raw}" doesn't look like an issue id (expected RTSC-NN or a bare number).` };
}
