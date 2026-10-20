// RTSC-962 — the worktree census, as a PURE decision.
//
// The proxy watches for git worktrees on `rtsc-NN/<slug>` branches that no claim this
// session took covers, and reports them so the server can record a provisional hold.
// That closes the one transition Retasc could never see: an agent starting work. (The
// end of work is fenced — `done` rejects on CLAIM_MISMATCH — and the start was not, so
// an agent could build ~2,000 lines against an issue the queue showed as free. RTSC-910.)
//
// Everything decidable without I/O lives here, so every branch is unit-testable: which
// trees count, which are ignored, and what the payload looks like. The proxy supplies
// the three facts only the filesystem knows (the porcelain output, whether a tree is
// dirty, its last commit time) and does nothing else.
//
// REPORT-ONLY, in both directions. Nothing here claims, blocks, or rewrites an agent's
// request; and a report that fails is swallowed by the caller, never surfaced as a
// failure of the tool call it rode alongside.

import { issueIdFromBranch, parseWorktreePorcelain, type Worktree } from "./tidy.js";

/** One reported tree, exactly as `report_worktrees` takes it. */
export type WorktreeReport = {
  identifier: string;
  branch: string;
  dirty: boolean;
  lastCommitAt?: number;
};

/** What the proxy can observe about one worktree. Supplied by the caller (git I/O). */
export type TreeState = {
  /** `git status --porcelain` produced output — there are uncommitted changes. */
  dirty: boolean;
  /** `git log -1 --format=%ct`, in epoch MILLISECONDS, or undefined if git couldn't say. */
  lastCommitAt?: number;
};

/**
 * How recently a worktree must have been touched to count as ACTIVE.
 *
 * This is what stops an abandoned worktree parking an issue. A tree nobody has
 * committed in for a day and that has no uncommitted work in it is finished business —
 * somebody forgot to run `retasc tidy` — and reporting it would withhold an issue from
 * dispatch on the strength of a directory. A day is deliberately generous: a real agent
 * working across a weekend has uncommitted changes, which satisfies the other arm.
 */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is this tree worth reporting? Dirty OR committed within the window.
 *
 * The two arms cover the two shapes real in-flight work takes: edits not yet committed
 * (the RTSC-910 case, for most of its life) and commits not yet merged.
 */
export function isActive(state: TreeState, now: number): boolean {
  if (state.dirty) return true;
  return state.lastCommitAt !== undefined && now - state.lastCommitAt < ACTIVE_WINDOW_MS;
}

/**
 * The `rtsc-NN/<slug>` worktrees in this porcelain output, as {path, branch} pairs.
 *
 * Detached trees are dropped (`branch` is null — there is no issue to name) and so is
 * any branch off the convention. The prefix match is `issueIdFromBranch`, the SAME
 * parser `retasc tidy` uses to decide what it may delete and the mirror of the server's
 * `branchForIssue` — so a branch this reports a hold for is exactly a branch a claim
 * would have handed out.
 *
 * The MAIN checkout is included when it is itself on such a branch: an agent working in
 * the shared checkout (the thing the claim contract tells it not to do) still leaves a
 * branch to find, and that is the case most worth catching.
 */
export function candidateTrees(porcelain: string): { path: string; branch: string; identifier: string }[] {
  const out: { path: string; branch: string; identifier: string }[] = [];
  for (const w of parseWorktreePorcelain(porcelain) as Worktree[]) {
    if (!w.branch) continue; // detached, or bare
    const identifier = issueIdFromBranch(w.branch);
    if (!identifier) continue;
    out.push({ path: w.path, branch: w.branch, identifier });
  }
  return out;
}

/**
 * The payload to send, from the candidate trees plus what git said about each.
 *
 * Two exclusions, both deliberate:
 *  - INACTIVE trees (see `isActive`) — an abandoned directory must not park an issue.
 *  - Issues THIS session already holds a lease on. It claimed them; the server knows;
 *    a hold would be a worse copy of a fact it already has, and `report_worktrees`
 *    would ignore it anyway. Skipping here keeps the payload honest rather than
 *    relying on the server to discard most of it.
 *
 * Returns [] when there is nothing to say, which the caller uses to skip the call
 * entirely — a proxy in a repo with no agent worktrees makes no requests at all.
 */
export function buildReport(opts: {
  trees: { path: string; branch: string; identifier: string }[];
  /** What git said about each tree, keyed by path. A tree with no entry is skipped. */
  state: Map<string, TreeState>;
  /** Issues this session already holds (the watchdog's lease map keys). */
  held: Iterable<string>;
  now: number;
}): WorktreeReport[] {
  const heldSet = new Set(opts.held);
  const reports: WorktreeReport[] = [];
  const seen = new Set<string>();
  for (const t of opts.trees) {
    if (heldSet.has(t.identifier)) continue; // we claimed it — nothing to report
    if (seen.has(t.identifier)) continue; // one hold per issue, whatever the tree count
    const st = opts.state.get(t.path);
    if (!st) continue; // git couldn't read the tree — say nothing rather than guess
    if (!isActive(st, opts.now)) continue;
    seen.add(t.identifier);
    reports.push({
      identifier: t.identifier,
      branch: t.branch,
      dirty: st.dirty,
      ...(st.lastCommitAt !== undefined ? { lastCommitAt: st.lastCommitAt } : {}),
    });
  }
  return reports;
}

/**
 * Which holds are worth saying out loud right now, and the bookkeeping that keeps it to
 * ONCE PER HOLD — mutating `announced` in place.
 *
 * Two rules, and the first one is the whole point:
 *
 *  - ANNOUNCE EACH HOLD ONCE. The instinct is to repeat the line until the agent acts,
 *    and it is wrong: it is the failure the server-side riders are written against
 *    (RTSC-463 — "a paragraph repeated on every claim becomes wallpaper"). A hold stands
 *    for an hour, in which an agent can make a hundred tool calls. A line on all of them
 *    is not obeyed more, it is skipped — and it teaches the agent to skip the next one.
 *    The case that actually matters, a reader about to act on the issue, is caught again
 *    server-side by the `get_issue` rider, which has the context to say something useful.
 *  - FORGET a hold that has gone (claimed, closed, lapsed), so a genuinely new sighting
 *    of the same issue later speaks up again.
 *
 * Pure but for `announced`, which is the caller's own set — so the ordering rule that
 * matters (never mark a hold announced unless the line actually reached the response)
 * stays enforceable by the caller, and testable here.
 */
export function holdsToAnnounce(
  active: Map<string, string>,
  announced: Set<string>,
  held: Iterable<string> = [],
): string[] {
  for (const id of [...announced]) if (!active.has(id)) announced.delete(id);
  // Never announce a hold for an issue this session now HOLDS. The scan that confirmed
  // the hold runs before the claim, so without this the very response to
  // `claim_issue RTSC-N` carries "nobody holds RTSC-N, run `claim_issue RTSC-N`" — a
  // line that contradicts the result it is stapled to, and which burns the single
  // announcement this hold ever gets.
  const heldSet = new Set(held);
  return [...active.keys()].filter((id) => !announced.has(id) && !heldSet.has(id));
}

/**
 * The line appended to the agent's own response when the server confirms a hold this
 * proxy reported (RTSC-962).
 *
 * It rides the RESPONSE rather than a tool description for the reason RTSC-463 gives: a
 * description is fetched once at `tools/list`, so it never reaches a session already
 * running, and this has to land adjacent to the moment it is about.
 *
 * SHORT, and it names the branch, because the reader's next action is to look at that
 * branch. Fires only while the hold stands — it clears the moment somebody claims.
 */
export function unclaimedNotice(holds: string[], byIssue: Map<string, string>): string {
  if (holds.length === 0) return "";
  const parts = holds.map((id) => `\`${byIssue.get(id) ?? id}\` (${id})`);
  const which = parts.length === 1 ? parts[0] : parts.join(", ");
  const verb = parts.length === 1 ? "exists" : "exist";
  const ids = holds.join(", ");
  return (
    `⚑ Unclaimed work: a worktree on ${which} ${verb} on this machine and nobody holds ` +
    `${ids}. If it is yours, run \`claim_issue ${holds[0]}\` now; if not, leave it — do not ` +
    `start a second branch for it.`
  );
}

/** The JSON-RPC `report_worktrees` call the proxy sends out-of-band. */
export function reportRequest(rpcId: number, worktrees: WorktreeReport[]) {
  return {
    jsonrpc: "2.0" as const,
    id: rpcId,
    method: "tools/call" as const,
    params: { name: "report_worktrees", arguments: { worktrees } },
  };
}

/** The issue ids the server confirmed it holds, from a `report_worktrees` result. */
export function holdsFrom(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const holds = (result as { holds?: unknown }).holds;
  if (!Array.isArray(holds)) return [];
  return holds.filter((h): h is string => typeof h === "string");
}
