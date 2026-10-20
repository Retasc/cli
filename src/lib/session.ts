// Session-key adoption core (RTSC-143) — the mint call the proxy runs on startup
// (RTSC-50), extracted here so the retry + failure behavior is unit-testable with
// a stubbed fetch. Fail-soft stands: a broken mint must never take the MCP down —
// but the fallback must be LOUD, because on the shared workspace key concurrent
// sessions collapse into one server-side identity and the per-session claim fence
// (RTSC-49/50) is silently inert.

import { toolResult } from "./toolresult.js";

export type MintOutcome = { ok: true; key: string; session?: string } | { ok: false };

// Out-of-band ids are negative so they never collide with the harness's (the same
// convention as the proxy's heartbeat ids). One id per out-of-band call, named rather
// than counted: the offsets these replaced had drifted into a collision, with
// `announceBinding` and `record_session` both sending -1001.
export const RPC_ID = {
  mint: -1000,
  announce: -1001,
  recordSession: -1002,
  nameWorkspace: -1003,
  // RTSC-1014 — the harness mint, which runs BEFORE the session mint once the
  // handshake has named the tool.
  mintHarness: -1004,
} as const;

const MINT_RPC_ID = RPC_ID.mint;

// The mint runs BEFORE the proxy serves `initialize`, so a hung server must not
// stall startup past the harness's MCP timeout — that would turn "degraded
// identity" into "no Retasc tools at all", the exact failure fail-soft exists
// to avoid. Two attempts fit comfortably inside a ~30s harness budget.
const MINT_TIMEOUT_MS = 5_000;

const FALLBACK_CONSEQUENCE =
  "concurrent sessions will be indistinguishable to the server and the " +
  "per-session claim fence is OFF for this session. Restart the session to retry.";

/**
 * Mint a per-session key, retrying once (a startup network blip must not demote
 * the whole session's identity). Never throws. On double failure, emits an
 * unmissable multi-line warning stating the consequence and returns {ok:false}
 * so the caller can keep flagging the degraded state (e.g. on whoami).
 */
export async function mintSessionKey(opts: {
  url: string;
  key: string;
  label: string;
  /** RTSC-861 — this build's own version, so the server never has to infer whether the
   *  proxy is current. Optional so a caller that has no version still mints. */
  cliVersion?: string;
  /** RTSC-1153 — whether this machine updates itself, and whether that last failed. The
   *  server's stale-CLI notice stays quiet for "on", and speaks for "off" and "failed". */
  autoUpdate?: "on" | "off" | "failed";
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
  retryDelayMs?: number;
  /** RTSC-1194 — false when the caller does NOT fall back to the workspace key on failure
   *  (the proxy replacing an expired key), so the warning saying it does would be false. */
  fallbackNotice?: boolean;
}): Promise<MintOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const warn = opts.warn ?? ((msg) => process.stderr.write(`[retasc] ${msg}\n`));
  const retryDelayMs = opts.retryDelayMs ?? 500;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: MINT_RPC_ID,
          method: "tools/call",
          params: {
            name: "mint_session_key",
            arguments: {
              label: opts.label,
              ...(opts.cliVersion ? { cliVersion: opts.cliVersion } : {}),
              // RTSC-1153 — first attempt only. A backend deployed before this field (or
              // rolled back past it) refuses the whole call over an argument it does not
              // know, which would cost this session its own key and the claim fence with
              // it. The retry goes without it: an old backend treats that as an old proxy.
              ...(opts.autoUpdate && attempt === 1 ? { autoUpdate: opts.autoUpdate } : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      const text = await res.text();
      // A non-2xx (revoked key → 401, server error → 5xx) must not masquerade
      // as "no key in response" — surface the status so a dead key is obvious.
      if (!res.ok) {
        const snippet = text ? `: ${text.slice(0, 120).replace(/\s+/g, " ").trim()}` : "";
        warn(`mint_session_key attempt ${attempt} failed (HTTP ${res.status})${snippet}`);
      } else {
        const r = toolResult(text ? JSON.parse(text) : null, warn);
        if (r && typeof r === "object" && typeof (r as { key?: unknown }).key === "string") {
          return { ok: true, key: (r as { key: string }).key, session: (r as { session?: string }).session };
        }
        warn(`mint_session_key attempt ${attempt} returned no key`);
      }
    } catch (e) {
      warn(`mint_session_key attempt ${attempt} failed: ${String((e as any)?.message ?? e)}`);
    }
    if (attempt === 1 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  warn("WARNING: could not mint a per-session key (retried once).");
  if (opts.fallbackNotice !== false) warn(`WARNING: continuing on the SHARED WORKSPACE KEY — ${FALLBACK_CONSEQUENCE}`);
  return { ok: false };
}

/**
 * The warning content block appended to whoami responses when the session is
 * running on the workspace-key fallback — so the AGENT sees the degraded state,
 * not just whoever reads the MCP log files.
 */
export const MINT_FALLBACK_NOTICE =
  "⚠ Retasc watchdog: this session could not mint a per-session key and is using " +
  `the shared workspace key — ${FALLBACK_CONSEQUENCE}`;

/**
 * Append MINT_FALLBACK_NOTICE to a whoami response when degraded. Defensive on
 * purpose: anything unexpected about the shape (error response, missing/non-array
 * content) leaves the response untouched — a malformed notice must never break
 * the protocol stream this rides on.
 */
export function appendFallbackNotice(toolName: unknown, resp: unknown, degraded: boolean): void {
  if (!degraded || toolName !== "whoami") return;
  const result = (resp as any)?.result;
  if (result?.isError) return; // don't decorate an error response
  if (Array.isArray(result?.content)) {
    result.content.push({ type: "text", text: MINT_FALLBACK_NOTICE });
  }
}

/**
 * One out-of-band `tools/call` (RTSC-825). The proxy makes several of these around a
 * session's start — mint the session key, announce the binding, record the transcript,
 * name the folder — and they had been written out longhand each time, so a change to
 * the transport (the auth header, the timeout, how a failure is surfaced) had to be
 * made in three places and would have been made in one.
 *
 * Every caller here is best-effort: the session must serve MCP traffic whatever the
 * server says, so this NEVER throws. `expect` is the field the tool returns on success;
 * its presence is what separates a real result from an error envelope carrying prose.
 */
async function callTool(opts: {
  url: string;
  key: string;
  id: number;
  name: string;
  args: Record<string, unknown>;
  expect: string;
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
}): Promise<"ok" | "refused" | "unreachable"> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const warn = opts.warn ?? ((msg) => process.stderr.write(`[retasc] ${msg}\n`));
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: opts.id,
        method: "tools/call",
        params: { name: opts.name, arguments: opts.args },
      }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      warn(`${opts.name} failed (HTTP ${res.status})`);
      // 5xx is the server having a bad minute; anything else is it saying no.
      return res.status >= 500 ? "unreachable" : "refused";
    }
    const r = toolResult(text ? JSON.parse(text) : null, warn);
    if (r && typeof r === "object" && opts.expect in (r as object)) return "ok";
    // A 200 carrying an error result: an unknown tool on an older deployment, a
    // revoked key, the wrong kind of key. All of them are answers, not outages.
    return "refused";
  } catch (e) {
    warn(`${opts.name} failed: ${String((e as any)?.message ?? e)}`);
    return "unreachable";
  }
}

/**
 * Record the harness's transcript id on THIS session's key (RTSC-820). Best effort and
 * quiet: the worst case is the Dash saying "none recorded", which is what it said
 * before this existed. Returns true once the server has it (already-recorded counts).
 */
export async function recordSession(opts: {
  url: string;
  key: string;
  transcriptId: string;
  harness?: string;
  /** RTSC-821 — sent when the harness reported them, omitted otherwise.
   *
   *  The BACKEND MUST DEPLOY BEFORE this version is published. `record_session` spreads
   *  tool arguments straight into the mutation (`convex/http.ts`), and a Convex `args`
   *  validator REJECTS unknown fields — so against a deployment that predates these
   *  three, the whole call fails and the transcript id is lost with them, regressing
   *  RTSC-820 for anyone who upgrades the CLI first. */
  model?: string;
  agentType?: string;
  agentId?: string;
  /** RTSC-1057 — how long THIS machine keeps the file, read from the harness's own
   *  settings. Same deploy-order rule as the three above: the backend has to know the
   *  field before a CLI that sends it is published. */
  transcriptKeepDays?: number;
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
}): Promise<boolean> {
  const out = await callTool({
    ...opts,
    id: RPC_ID.recordSession,
    name: "record_session",
    args: {
      transcriptId: opts.transcriptId,
      ...(opts.harness ? { harness: opts.harness } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agentType ? { agentType: opts.agentType } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.transcriptKeepDays ? { transcriptKeepDays: opts.transcriptKeepDays } : {}),
    },
    expect: "transcriptId",
  });
  return out === "ok";
}

/**
 * What naming a folder did. The two failures are different facts and the receipt says
 * so: a server we could not reach may work in a minute, a REFUSAL will say the same
 * thing forever (the key was revoked, the org is gone, or the deployment predates the
 * tool). Reporting a refusal as "could not reach Retasc" sends someone to check their
 * network over a folder that will never be named until they act.
 */
export type NameOutcome = "named" | "unreachable" | "refused";

/**
 * Tell Retasc which folder a workspace key is bound to (RTSC-825). Best effort and
 * quiet, like `recordSession`: the worst case is the Dash omitting the workspace, which
 * is what it did before this existed. "named" once the server holds this folder
 * (already-correct counts).
 */
export async function nameWorkspace(opts: {
  url: string;
  key: string;
  workspace: string;
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
}): Promise<NameOutcome> {
  const out = await callTool({
    ...opts,
    id: RPC_ID.nameWorkspace,
    name: "name_workspace",
    args: { workspace: opts.workspace },
    expect: "workspace",
  });
  return out === "ok" ? "named" : out;
}

// ---------------------------------------------------------------------------
// The HARNESS tier (RTSC-1014)
// ---------------------------------------------------------------------------

/**
 * The phrase the server refuses a RETIRED harness with.
 *
 * A `userError`'s structured `code` does not survive the MCP tool-result envelope —
 * `convex/http.ts` renders `errorText(e)` into `content[0].text` and drops `.data` for
 * everything but `askHuman` — so the text IS the wire contract here, and matching it is
 * not a hack, it is the only signal there is. `harnessRetired1014.test.ts` reads
 * `convex/manage.ts` and fails if the server stops emitting this exact phrase, so the two
 * ends cannot drift apart silently.
 *
 * Getting this wrong is not cosmetic: a retired harness that reads as an ordinary mint
 * failure falls back to the shared workspace key and keeps running, which is precisely
 * the retire the user asked for, silently undone.
 */
export const HARNESS_RETIRED_MARKER = "was retired in this workspace";

export type HarnessOutcome =
  | { ok: true; key: string; harness: string }
  /** The server refused because this harness was retired here. NEVER fall back. */
  | { ok: false; retired: true }
  /** Anything else — old server, network, an unnameable harness. Fall back and say so. */
  | { ok: false; retired: false };

/**
 * Mint (or re-mint) the credential for ONE tool in this workspace.
 *
 * Unlike `mintSessionKey` this does NOT retry. A retry is right for a startup network
 * blip, which is what the session mint faces; here the two outcomes that matter are
 * "retired" (retrying cannot help and delay costs the handshake budget) and "anything
 * else" (the caller falls back to the workspace key immediately, which is the behaviour
 * that shipped before this tier existed). Never throws.
 */
export async function mintHarnessKey(opts: {
  url: string;
  key: string;
  harness: string;
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
}): Promise<HarnessOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const warn = opts.warn ?? ((msg) => process.stderr.write(`[retasc] ${msg}\n`));
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: RPC_ID.mintHarness,
        method: "tools/call",
        params: { name: "mint_harness_key", arguments: { harness: opts.harness } },
      }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    const text = await res.text();
    // The retired refusal arrives as a tool RESULT with `isError`, not a transport
    // error, so it has to be read out of a 200 as well as out of a non-2xx.
    if (text.includes(HARNESS_RETIRED_MARKER)) {
      warn(`${opts.harness} was retired in this workspace — refusing to run it on the shared key.`);
      return { ok: false, retired: true };
    }
    if (!res.ok) {
      const snippet = text ? `: ${text.slice(0, 120).replace(/\s+/g, " ").trim()}` : "";
      warn(`mint_harness_key failed (HTTP ${res.status})${snippet}`);
      return { ok: false, retired: false };
    }
    const r = toolResult(text ? JSON.parse(text) : null, warn);
    if (r && typeof r === "object" && typeof (r as { key?: unknown }).key === "string") {
      const got = r as { key: string; harness?: string };
      return { ok: true, key: got.key, harness: got.harness ?? opts.harness };
    }
    warn(`mint_harness_key returned no key — this session stays on the workspace key.`);
    return { ok: false, retired: false };
  } catch (e) {
    warn(`mint_harness_key failed: ${String((e as any)?.message ?? e)}`);
    return { ok: false, retired: false };
  }
}
