// Liveness watchdog core (RTSC-44) — pure, harness-agnostic lease tracking.
//
// The proxy (proxy.ts) feeds this the MCP tool calls it sees flow through. This
// module maintains the set of leases THIS session holds (issueId → claimToken),
// so a timer can heartbeat them deterministically — the LLM never participates.
// No I/O here on purpose: it's the correctness core, unit-tested in isolation.

export type Leases = Map<string, string>; // issueId -> claimToken

export type Observation = {
  toolName: string; // the tools/call name (e.g. "next_issue")
  args?: Record<string, unknown>; // the request arguments
  result?: unknown; // the parsed tool result (the JSON inside content[0].text)
};

function idOf(issue: unknown): string | undefined {
  if (typeof issue === "string") return issue;
  if (issue && typeof issue === "object" && typeof (issue as { id?: unknown }).id === "string") {
    return (issue as { id: string }).id;
  }
  return undefined;
}

/**
 * Update the lease set from one observed tool call (its request args + result).
 * - next_issue / claim_issue response → { issue:{id}|"ID", claimToken } → register
 * - next_batch(claim) response → { issues:[{id, claimToken}] } → register each
 * - release_issue request → drop that issue's lease
 * - save_issue(status: done|canceled) request → drop that issue's lease
 *
 * Every drop requires the call to have SUCCEEDED (RTSC-741) — a rejected write leaves
 * the lease in place, because the agent still holds the issue server-side.
 */
export function applyObservation(leases: Leases, o: Observation): void {
  const r = o.result;
  if (r && typeof r === "object") {
    const obj = r as { claimToken?: unknown; issue?: unknown; issues?: unknown };
    if (typeof obj.claimToken === "string") {
      const id = idOf(obj.issue);
      if (id) leases.set(id, obj.claimToken);
    }
    if (Array.isArray(obj.issues)) {
      for (const it of obj.issues) {
        if (it && typeof it.id === "string" && typeof it.claimToken === "string") {
          leases.set(it.id, it.claimToken);
        }
      }
    }
  }

  // Releases / terminal status drop the lease — the issue is named in the REQUEST.
  //
  // RTSC-741: but ONLY if the call actually succeeded. These branches read the REQUEST
  // shape, so a REJECTED write used to drop the lease of an issue the agent still holds
  // server-side. Nothing then renews it, it runs out the bare 30-minute TTL, and the
  // reclaimer hands the issue to someone else while the agent is still working on it.
  // `shouldReapOnClose` below already applies exactly this check for the same reason.
  //
  // It matters now because RTSC-741 made `save_issue status:"review"` REJECTABLE
  // (HANDOFF_REQUIRED): a rejected review write is the expected first attempt for any
  // agent that hasn't learned the field yet, and for every already-running session whose
  // cached tool schema predates the deploy. What was a rare edge is briefly the norm.
  //
  // Erring toward KEEPING the lease is the safe direction, and the module already relies
  // on it: a lease held after the server released it just fails its next heartbeat and
  // self-heals (see the send-back note below), whereas a lease dropped too early is
  // silent and costs the agent its work.
  const succeeded = !!o.result && !isToolError(o.result);
  const id =
    succeeded && typeof o.args?.identifier === "string" ? o.args.identifier : undefined;
  if (id && o.toolName === "release_issue") leases.delete(id);
  // RTSC-321: moving to `review` (RTSC-257) hands the lease back server-side (the
  // author's work is done, pending a reviewer), so stop heartbeating it — like a
  // release, NOT a terminal close. It must NOT reap: `terminalCloseId` stays
  // done|canceled only, so the branch/worktree survives for the review + PR. (The
  // reviewer's send-back review→todo also releases server-side but is undetectable
  // from args alone — doing→todo does NOT release — so that case self-heals via the
  // failed-heartbeat path instead.)
  if (id && o.toolName === "save_issue" && o.args?.status === "review") leases.delete(id);
  const closeId = succeeded ? terminalCloseId(o) : undefined;
  if (closeId) leases.delete(closeId);
}

/**
 * The issue id to reap if this observation is a terminal close (done|canceled) via
 * `save_issue`, else undefined. This is the SAME rule applyObservation uses to drop
 * the lease — factored out so "which calls end an issue" lives in one place and the
 * proxy's auto-reap (RTSC-181) can't drift from the lease bookkeeping. The caller
 * decides whether it actually held the lease and whether the call succeeded
 * (`isToolError`) before acting — this only classifies the request shape.
 */
export function terminalCloseId(o: Observation): string | undefined {
  if (o.toolName !== "save_issue") return undefined;
  const id = typeof o.args?.identifier === "string" ? o.args.identifier : undefined;
  if (!id) return undefined;
  const status = o.args?.status;
  return status === "done" || status === "canceled" ? id : undefined;
}

/**
 * Did a tools/call result come back as an MCP error envelope (`{ isError: true }`)?
 * Used to gate side effects — the proxy must never reap a branch off a `save_issue`
 * that actually FAILED server-side. Distinct from isClaimLost (which matches a
 * specific error string); this is the generic "did the tool error at all" check.
 */
export function isToolError(result: unknown): boolean {
  return (
    !!result && typeof result === "object" && (result as { isError?: unknown }).isError === true
  );
}

/**
 * The full RTSC-181 reap gate as ONE pure decision: given an observed tool call and
 * the leases this session holds, return the issue id to reap — or undefined. Reap ONLY
 * when ALL hold:
 *   1. it's a terminal close (save_issue done|canceled),
 *   2. of an issue THIS session actually claimed (in `leases` — never someone else's),
 *   3. and the call genuinely succeeded — a truthy payload that is not an error
 *      envelope. A transport-level failure yields an undefined result (no envelope to
 *      catch); requiring a truthy payload means we never reap off a failed close.
 * This is the security-critical check — keeping it pure makes every branch testable
 * (the proxy just spawns on a non-undefined return).
 */
export function shouldReapOnClose(o: Observation, leases: Leases): string | undefined {
  const id = terminalCloseId(o);
  if (!id) return undefined;
  if (!leases.has(id)) return undefined;
  if (!o.result || isToolError(o.result)) return undefined;
  return id;
}

/**
 * Did this observation actually TAKE a lease — i.e. is it a successful claim?
 *
 * RTSC-1042: the proxy sweeps this machine's dead worktrees on the first claim of a
 * session, because that is the moment the sweep's precondition is finally true. The
 * on-close reap asks "is this branch merged?" at `done`, when a human has not merged
 * the PR yet and the honest answer is always no; by the next claim those merges have
 * landed. Same question, a moment when it can be answered.
 *
 * Matched on the RESULT, never the tool name. `next_issue` can come back empty when
 * the queue has nothing free, and `next_batch` peeks without claiming by default —
 * both are the tools an agent calls when it is NOT taking work, and neither took a
 * lease. This mirrors the registration branch of `applyObservation` so the two cannot
 * disagree about what a claim looks like.
 */
export function isClaimObservation(o: Observation): boolean {
  const r = o.result;
  if (!r || typeof r !== "object" || isToolError(r)) return false;
  const obj = r as { claimToken?: unknown; issues?: unknown };
  if (typeof obj.claimToken === "string") return true;
  return (
    Array.isArray(obj.issues) &&
    obj.issues.some(
      (it) => !!it && typeof it === "object" && typeof (it as { claimToken?: unknown }).claimToken === "string",
    )
  );
}

/** A JSON-RPC `heartbeat` tool call for one lease (the proxy's timer sends these). */
export function heartbeatRequest(rpcId: number, issueId: string, claimToken: string) {
  return {
    jsonrpc: "2.0" as const,
    id: rpcId,
    method: "tools/call" as const,
    params: { name: "heartbeat", arguments: { identifier: issueId, claimToken } },
  };
}

/**
 * Does a tool result carry SERVER ERROR signal `code`? The shared matcher behind
 * isClaimLost / isUnauthorized.
 *
 * The server throws `Error("CLAIM_LOST: …")` / `Error("UNAUTHORIZED: …")`
 * (convex/lib/claims.ts, convex/lib/auth.ts), and http.ts surfaces that as an MCP
 * tool ERROR: `{ isError: true, content:[{text:"CLAIM_LOST: …"}] }`. Match ONLY that
 * signal (or a top-level `error`/`code` field, for a future structured shape) —
 * NEVER `JSON.stringify` the whole result and regex it, or a benign payload field
 * that merely CONTAINS the code (an issue title, a checkpoint note quoting an error,
 * a comment body) would silently drop a live lease and let the reclaimer hand our
 * work to someone else (RTSC-150).
 */
function hasErrorCode(result: unknown, code: string): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { isError?: unknown; content?: unknown; error?: unknown; code?: unknown };

  // Substring match, NOT `new RegExp(code)`: the codes are fixed literals, so a
  // regex buys nothing and turns any future caller-supplied code into a regex
  // injection / ReDoS shape. `.includes` is the same match with none of that.
  const carries = (s: string) => s.includes(code);

  // A structured error signal on a top-level field (belt-and-suspenders; also the
  // shape the older unit test asserts). Bounded to top-level scalars, not nested.
  if (r.code === code) return true;
  if (typeof r.error === "string" && carries(r.error)) return true;

  // The live shape: only an MCP error envelope, and only its text blocks — success
  // payloads (isError absent/false) are never treated as an error.
  if (r.isError !== true || !Array.isArray(r.content)) return false;
  return r.content.some(
    (c) =>
      c !== null &&
      typeof c === "object" &&
      typeof (c as { text?: unknown }).text === "string" &&
      carries((c as { text: string }).text),
  );
}

/**
 * RTSC-1194 — the server refused this session's key as EXPIRED: a sweep retired it because
 * it went unused (`revokedReason: "unadopted"`), not because anyone asked. `resolveAuth`
 * uses this wording for that case alone, so it is the one refusal a proxy may repair by
 * minting a fresh session key from the same parent. A key a person revoked says "has been
 * revoked" instead and must stay stopped. Matched on the FIRST content block only, which is
 * where `convex/http.ts` puts the auth error itself.
 */
export const SESSION_KEY_EXPIRED_PREFIX = "UNAUTHORIZED: session key expired";
export function isSessionKeyExpired(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true || !Array.isArray(r.content)) return false;
  const first = r.content[0] as { text?: unknown } | undefined;
  return !!first && typeof first.text === "string" && first.text.startsWith(SESSION_KEY_EXPIRED_PREFIX);
}

/** A heartbeat CLAIM_LOST means the lease is gone — stop tracking it. */
export function isClaimLost(result: unknown): boolean {
  return hasErrorCode(result, "CLAIM_LOST");
}

/**
 * A heartbeat UNAUTHORIZED means the CREDENTIAL died, not the lease (RTSC-646).
 * `resolveAuth` throws it when the key was revoked or rotated, its parent key was
 * revoked, or the member was suspended/retired — so EVERY lease in this session
 * stops renewing at once and each one lapses at its own expiry.
 *
 * Deliberately NOT treated like CLAIM_LOST: the claims are still ours and still
 * live server-side, so dropping them from the map would hide exactly the leases
 * the human needs to hear about. We keep tracking, keep trying (a re-mint can fix
 * it inside the TTL), and say so loudly.
 */
export function isUnauthorized(result: unknown): boolean {
  return hasErrorCode(result, "UNAUTHORIZED");
}

/**
 * The renewal-visibility warning (RTSC-646): this session is touching a lease the
 * watchdog is NOT renewing, so it runs on the bare 30-minute TTL.
 *
 * The lease map is in-memory and built ONLY from claim traffic this process saw, so
 * a claim made in another terminal, over direct HTTP MCP, or by a previous proxy
 * before a harness restart is renewed by nobody — and today that is silent until
 * the reclaimer takes the issue away mid-work. Two observable tells, both meaning
 * "we hold it, we aren't renewing it":
 *   1. a request carrying a `claimToken` for an issue we don't track (the agent is
 *      hand-heartbeating/checkpointing a lease we never saw claimed), and
 *   2. a `check_claim` answering `youHold: true` for an issue we don't track.
 * Returns the warning text, or undefined when there's nothing to say. Pure so the
 * decision is testable without a proxy; the caller does the printing.
 */
export function untrackedLeaseWarning(o: Observation, leases: Leases): string | undefined {
  const id = typeof o.args?.identifier === "string" ? o.args.identifier : undefined;
  if (!id || leases.has(id)) return undefined;
  // `release_issue` also carries a claimToken, but it ENDS the lease. Warning
  // "nothing is renewing it, heartbeat it yourself" about a claim the agent is
  // deliberately handing back is advice for the opposite of what it just did.
  if (o.toolName === "release_issue") return undefined;

  const holds =
    typeof o.args?.claimToken === "string" ||
    (!!o.result &&
      typeof o.result === "object" &&
      (o.result as { youHold?: unknown }).youHold === true);
  if (!holds) return undefined;

  return (
    `lease for ${id} is NOT tracked by this proxy — nothing is renewing it, so it ` +
    `runs on the bare 30-minute TTL and the reclaimer will take it mid-work. ` +
    `This happens when the claim was made in another terminal, over direct HTTP MCP, ` +
    `or by a previous proxy before a restart. Heartbeat or checkpoint it yourself ` +
    `(checkpoint is better — it renews AND leaves the handoff note), or release it ` +
    `and re-claim through this session.`
  );
}
