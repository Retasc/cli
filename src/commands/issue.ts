import { spawnSync } from "node:child_process";
import {
  resolveMcpConn,
  readMcpJson,
  mcpCall,
  resolveIssueRef,
  isValidIssueId,
  type McpConn,
  type PrefixCache,
} from "../lib/claim.js";
import { issueIdFromBranch } from "../lib/tidy.js";
import { loadConfig } from "../config.js";
import { issueView, issueListView, claimStatusView } from "../lib/format.js";

// RTSC-709 — the read half of the claim lifecycle.
//
// The CLI could claim work, release it and close it, but never SHOW it. That gap is
// load-bearing in two places: `retasc tidy` gives a verdict per branch derived from issue
// status, and `retasc done` writes a terminal status, and a human judging either had to
// open the Dash to see what they were judging. `checkpoint` and `check-claim` are the same
// gap on the lease: you could take a lease and hand it back, but not record progress on it
// or ask whether anything was still renewing it.
//
// Everything here is a thin pass to the MCP tool of the same name over the workspace's own
// key, so the CLI and the agent read exactly the same rows. The formatting lives in
// lib/format.ts, pure and pinned by tests.

/** The workspace's MCP connection, or a message naming how to get one. */
function conn(): McpConn {
  const c = resolveMcpConn({ mcpJson: readMcpJson() });
  if (!c.key) {
    throw new Error(
      "No Retasc MCP key found for this folder.\n" +
        "  Run `retasc bind` here (or `retasc mcp install`), or set RETASC_MCP_KEY.",
    );
  }
  return c;
}

function currentBranch(): string | null {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() || null : null;
}

/**
 * The issue this command is about: what was typed, or the one the current `rtsc-NN/`
 * branch is for.
 *
 * The branch fallback is the same one `retasc done` uses, and it is the form that matters
 * in a worktree: you are standing in the checkout for exactly one issue, and naming it
 * again is a chance to name the wrong one.
 */
async function targetIssue(c: McpConn, raw?: string): Promise<string> {
  if (raw !== undefined) {
    const cache: PrefixCache = { fallback: () => loadConfig().defaultProjectPrefix };
    const resolved = await resolveIssueRef(c, raw, cache);
    if (resolved.error !== undefined) throw new Error(resolved.error);
    return resolved.id;
  }
  const branch = currentBranch();
  const fromBranch = branch ? issueIdFromBranch(branch) : null;
  if (!fromBranch || !isValidIssueId(fromBranch)) {
    throw new Error("Which issue? Pass one (e.g. RTSC-42), or run this from its `rtsc-NN/` branch.");
  }
  return fromBranch;
}

// --- issue show / issue list ------------------------------------------------

export async function issueShowAction(opts: { issueArg?: string; json?: boolean }): Promise<void> {
  const c = conn();
  const identifier = await targetIssue(c, opts.issueArg);
  const issue = (await mcpCall(c, "get_issue", { identifier })) as any;
  console.log(opts.json ? JSON.stringify(issue, null, 2) : issueView(issue));
}

// A local copy of the server's `STATUS` union (convex/schema.ts), kept so a typo fails
// here with the list in it instead of as a validator error from the wire. It is drift-
// guarded: convex/cliStatusDrift709.test.ts fails if the two ever disagree.
const STATUSES = ["todo", "doing", "blocked", "review", "done", "canceled"] as const;
const SLA_STATES = ["ok", "warning", "breaching", "breached"] as const;

export type IssueListOpts = {
  status?: string;
  priority?: string;
  label?: string;
  author?: string;
  assignee?: string;
  sla?: string;
  limit?: string;
  json?: boolean;
};

export async function issueListAction(opts: IssueListOpts): Promise<void> {
  const args: Record<string, unknown> = {};

  if (opts.status) {
    // Comma-separated because the server takes one status or many, and a filter you can
    // only pass one value to is the reason someone goes back to the Dash.
    const wanted = opts.status.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = wanted.filter((s) => !(STATUSES as readonly string[]).includes(s));
    if (bad.length) {
      throw new Error(`Unknown status: ${bad.join(", ")}. Pick from ${STATUSES.join(" | ")}.`);
    }
    args.status = wanted.length === 1 ? wanted[0] : wanted;
  }
  if (opts.priority !== undefined) {
    const p = Number(opts.priority);
    // NaN would reach the server as `null` and silently widen the filter to everything.
    if (!Number.isInteger(p) || p < 0 || p > 4) throw new Error("--priority takes 0..4 (0 = none, 1 = urgent).");
    args.priority = p;
  }
  if (opts.sla) {
    const s = opts.sla.trim().toLowerCase();
    if (!(SLA_STATES as readonly string[]).includes(s)) {
      throw new Error(`Unknown --sla: ${opts.sla}. Pick from ${SLA_STATES.join(" | ")}.`);
    }
    args.slaState = s;
  }
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1) throw new Error("--limit takes a positive whole number (max 200).");
    args.limit = n;
  }
  for (const k of ["label", "author", "assignee"] as const) if (opts[k]) args[k] = opts[k];

  const res = (await mcpCall(conn(), "list_issues", args)) as any;
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const rows: any[] = Array.isArray(res?.issues) ? res.issues : [];
  console.log(issueListView(rows));
  // The default filter hides done + canceled, so a short list is not necessarily a small
  // project. Say which set was counted rather than letting the number imply the whole one.
  if (rows.length) {
    console.log("");
    console.log(
      `${rows.length} issue${rows.length === 1 ? "" : "s"}${opts.status ? "" : " (active work; done and canceled are hidden, pass --status to include them)"}.`,
    );
  }
}

// --- checkpoint / check-claim ----------------------------------------------

/**
 * `retasc checkpoint [issue] --note … --claim-token …`
 *
 * The lease half of the gap. `workflow.md` tells a worker to checkpoint at any long-silence
 * boundary, and until now that instruction could only be followed by an agent: a human at a
 * terminal could take a lease and give it back, but not leave the note the next holder
 * resumes from. It renews the lease too, which is the other reason to run it.
 */
export async function checkpointAction(opts: {
  issueArg?: string;
  note?: string;
  claimToken?: string;
}): Promise<void> {
  if (!opts.note?.trim()) {
    throw new Error("A checkpoint needs a note: `retasc checkpoint --note \"what's done / what's next\"`.");
  }
  // Fenced by the server on claim_token (only the holder may write the note), and the CLI
  // stores no tokens, so refusing here with the reason beats sending a call that comes back
  // as a fence error with no context. Same contract as `retasc release`.
  if (!opts.claimToken) {
    throw new Error(
      "Checkpointing needs the issue's claim token: `retasc checkpoint --claim-token <token>`.\n" +
        "  The token is printed when you claim, and is in the `--json` output of `retasc claim`.\n" +
        "  It proves you are the session holding the lease, which is what stops one agent\n" +
        "  overwriting another's handoff note.",
    );
  }
  const c = conn();
  const identifier = await targetIssue(c, opts.issueArg);
  const res = (await mcpCall(c, "checkpoint", {
    identifier,
    note: opts.note,
    claimToken: opts.claimToken,
  })) as any;
  console.log(`✓ Checkpointed ${identifier}.`);
  if (typeof res?.claimExpiresAt === "number") {
    const mins = Math.round((res.claimExpiresAt - Date.now()) / 60000);
    console.log(`  Lease renewed, ${mins}m left. The note survives a release or a reclaim.`);
  }
}

/**
 * `retasc check-claim [issue]`
 *
 * Read-only. Exits non-zero when this session does not hold the lease, so it can gate the
 * thing its own tool description tells you to gate: `retasc check-claim && git commit …`.
 */
export async function checkClaimAction(opts: { issueArg?: string; json?: boolean }): Promise<void> {
  const c = conn();
  const identifier = await targetIssue(c, opts.issueArg);
  const res = (await mcpCall(c, "check_claim", { identifier })) as any;
  console.log(opts.json ? JSON.stringify(res, null, 2) : claimStatusView(res));
  if (!res?.youHold) process.exitCode = 1;
}
