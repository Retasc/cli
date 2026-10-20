import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import {
  resolveMcpConn,
  readMcpJson,
  mcpCall,
  parseClaimResult,
  planWorktree,
  isValidIssueId,
  normalizeIssueId,
  resolveIssueRef,
  type PrefixCache,
} from "../lib/claim.js";
import { loadConfig } from "../config.js";
import { clean } from "../lib/text.js";
import { resolveBase, baseHelp, type GitRun } from "../lib/base.js";

export type ClaimOpts = {
  id?: string;
  issueArg?: string; // positional issue reference (RTSC-148)
  base?: string;
  dir?: string;
  fetch?: boolean; // commander --no-fetch → fetch:false
  worktree?: boolean; // commander --no-worktree → worktree:false
  shell?: boolean;
  printPath?: boolean;
  json?: boolean;
  allLanes?: boolean;
};

function git(args: string[], cwd?: string) {
  return spawnSync("git", args, { encoding: "utf8", cwd });
}

function gitOut(args: string[], cwd?: string): string | null {
  const r = git(args, cwd);
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

/** stderr so --print-path / --json keep stdout machine-clean. */
function note(msg: string): void {
  process.stderr.write(msg + "\n");
}

/**
 * `retasc claim` / `retasc next`: atomically claim an issue over the workspace's
 * own MCP key, then create + drop you into a correctly-named git worktree
 * (`../<repo>-rtsc-NN` on branch `rtsc-NN/<slug>`). Makes isolation the path of
 * least resistance (RTSC-38) so two sessions can't silently share a checkout.
 */
export async function claimAction(opts: ClaimOpts): Promise<void> {
  const conn = resolveMcpConn({ mcpJson: readMcpJson() });
  if (!conn.key) {
    note("✗ No Retasc MCP key found. Run `retasc init` / `retasc mcp install`, or set RETASC_MCP_KEY.");
    note("  (Looked at $RETASC_MCP_KEY and ./.mcp.json.)");
    process.exit(1);
  }

  // RTSC-148: resolve the requested issue id up front — a positional (`claim 143`,
  // `claim RTSC-143`) or --id, normalized to PREFIX-NN. An unresolvable reference
  // fails HERE; it must never fall through to "claim whatever is next".
  // A bare number expands against the WORKSPACE's prefix (whoami over this
  // workspace's key — the key decides the org/project), falling back to the
  // global config only if the server can't be asked.
  // RTSC-709: the expansion rule itself now lives in lib/claim.ts (`resolveIssueRef`),
  // shared with `issue show` / `checkpoint` / `check-claim`. The cache keeps this loop to
  // a single `whoami` when both forms are passed, exactly as the inline version did.
  const prefixCache: PrefixCache = { fallback: () => loadConfig().defaultProjectPrefix };
  let requestedId: string | undefined;
  for (const [label, raw] of [
    ["issue", opts.issueArg],
    ["--id", opts.id],
  ] as const) {
    // Only ABSENT skips — an empty string (e.g. `claim "$UNSET_VAR"`) must hit
    // the loud-failure path below, not fall through to next_issue.
    if (raw === undefined) continue;
    const resolved = await resolveIssueRef(conn, raw, prefixCache);
    if (resolved.error) {
      note(`✗ ${resolved.error}`);
      process.exit(1);
    }
    if (requestedId && requestedId !== resolved.id) {
      note(`✗ Conflicting issue ids: positional "${requestedId}" vs ${label} "${resolved.id}". Pass just one.`);
      process.exit(1);
    }
    requestedId = resolved.id;
  }

  // --all-lanes widens the next_issue pull; on a targeted claim it would be
  // silently ignored — reject instead of letting the intent evaporate.
  if (requestedId && opts.allLanes) {
    note(`✗ --all-lanes only applies when pulling the next issue; drop it to claim ${requestedId} directly.`);
    process.exit(1);
  }

  const makeWorktree = opts.worktree !== false;

  // Must be in a git repo to place the worktree. Resolve the *main* checkout so
  // worktrees are always siblings of it, even when claiming from another worktree.
  let parentDir = opts.dir;
  let repoName = "repo";
  let inLinkedWorktree = false;
  let base = "";
  if (makeWorktree) {
    const commonDir = gitOut(["rev-parse", "--git-common-dir"]);
    const gitDir = gitOut(["rev-parse", "--git-dir"]);
    if (!commonDir || !gitDir) {
      note("✗ Not inside a git repository — can't create a worktree.");
      note("  Re-run from the repo, or pass --no-worktree to just claim.");
      process.exit(1);
    }
    // --git-common-dir always points at the MAIN checkout's .git; --git-dir
    // diverges (.git/worktrees/<name>) only inside a linked worktree.
    inLinkedWorktree = resolve(gitDir) !== resolve(commonDir);
    const mainCheckout = dirname(resolve(commonDir)); // <main>/.git → <main>
    repoName = basename(mainCheckout);
    parentDir = parentDir ?? dirname(mainCheckout);

    // RTSC-799: the branch base is discovered from the repo, not assumed to be
    // `origin/main`. Resolved HERE, before the claim: a lease taken for a worktree
    // that then can't be created leaves the issue held by an agent with nowhere to
    // work, and the caller has to hand it back to free it.
    //
    // The fetch comes FIRST, and has to. Resolving proves the base resolves to a
    // commit, and a base that is only on the remote so far (a just-pushed branch, a
    // --single-branch clone) does not resolve until it has been fetched. Proving
    // before fetching would refuse claims that worked before this change.
    if (opts.fetch !== false) {
      const named = opts.base?.startsWith("origin/") ? opts.base.slice("origin/".length) : null;
      const f = named ? git(["fetch", "origin", named]) : git(["fetch", "origin"]);
      if (f.status !== 0) note(`⚠ git fetch failed (${(f.stderr || "").trim().split("\n")[0]}); using local refs.`);
    }
    // Same cwd as `tidy` uses (the main checkout), so `claim` and the `tidy` that
    // later judges the branch can never read a different trunk for the same repo.
    const gitRun: GitRun = (args) => {
      const r = git(args, mainCheckout);
      return { status: r.status, stdout: r.stdout ?? "" };
    };
    const resolved = resolveBase(gitRun, opts.base);
    if (!resolved.ok) {
      for (const line of baseHelp(resolved)) note(line);
      note("  Nothing was claimed. Or pass --no-worktree to claim without one.");
      process.exit(1);
    }
    if (resolved.staleOriginHead) {
      note(`⚠ origin/HEAD still points at ${resolved.staleOriginHead}, which is gone. Branching from ${resolved.ref}.`);
    }
    base = resolved.ref;
  }

  // --- claim over MCP ------------------------------------------------------
  let claim;
  try {
    const result = requestedId
      ? await mcpCall(conn, "claim_issue", { identifier: requestedId })
      : await mcpCall(conn, "next_issue", opts.allLanes ? { allLanes: true } : {});
    claim = parseClaimResult(result);
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    note(`✗ ${msg}`);
    // Re-claiming an issue you already hold is the "resume my own work" case —
    // point at the worktree instead of leaving the user stuck on the error.
    if (requestedId && /ALREADY_CLAIMED/.test(msg) && makeWorktree) {
      note(`  ${requestedId} is held. If it's your session, resume in ${parentDir}/${repoName}-${requestedId.toLowerCase()}`);
      // Deliberately does NOT suggest `release` here. A lease held by a DIFFERENT session
      // is fenced: releasing it needs that session's claim token, which this caller does
      // not have and should not have. Naming a command they cannot run is the dead end
      // this hint exists to avoid. If it really is abandoned, the reclaimer frees it.
      note(`  If it isn't yours, wait for the lease to lapse — the server reclaims it automatically.`);
    }
    process.exit(1);
  }

  if (!claim.issueId) {
    // Empty next_issue — never a silent stall.
    note("· Nothing to claim right now.");
    if (claim.ready !== undefined) {
      note(`  ready: ${claim.ready ?? 0}  blocked: ${claim.blocked ?? 0}  claimed: ${claim.claimed ?? 0}`);
    }
    // RTSC-306: nothing in YOUR lane, but ready work is stranded in another
    // human's lane — offer the cross-lane opt-out rather than reading "empty".
    if (claim.otherLanes) {
      note(`  ${claim.otherLanes} ready in other humans' lanes — re-run with --all-lanes to pull them, or go unblock the owner.`);
    }
    process.exit(0);
  }

  // The id flows into a git ref and a filesystem path — reject a malformed one.
  if (!isValidIssueId(claim.issueId)) {
    // Named in words, not JSON.stringify'd. The value is either a string, in which case
    // quoting it is enough, or it is a shape — and dumping that shape tells the reader
    // nothing they can act on while looking exactly like a crash.
    const shown = typeof claim.issueId === "string" ? `"${clean(claim.issueId)}"` : "nothing usable";
    note(`✗ Retasc sent ${shown} where an issue id (like RTSC-42) should be.`);
    note(`  Nothing was branched or checked out. Try again, or run \`retasc doctor\`.`);
    process.exit(1);
  }

  // claim_issue returns just the id — fetch the title so the slug is meaningful.
  let title = claim.title;
  if (!title) {
    try {
      const full = (await mcpCall(conn, "get_issue", { identifier: claim.issueId })) as any;
      title = full?.title;
    } catch {
      note(`⚠ Couldn't fetch the title for ${claim.issueId} — branch slug falls back to "issue".`);
    }
  }

  const issueId = claim.issueId;
  if (!makeWorktree) {
    note(`✓ Claimed ${issueId}${title ? ` — ${title}` : ""}.`);
    if (claim.claimToken) note(`  claim token: ${claim.claimToken}`);
    if (opts.json) {
      console.log(JSON.stringify({ issueId, title, branch: null, path: null, claimToken: claim.claimToken }, null, 2));
    }
    return;
  }

  const plan = planWorktree({ issueId, title: title ?? "", repoName, parentDir: parentDir! });
  // Defense in depth: the derived worktree must stay under the parent dir.
  if (plan.path !== resolve(parentDir!) && !plan.path.startsWith(resolve(parentDir!) + sep)) {
    note(`✗ Refusing to create a worktree outside ${parentDir}: ${plan.path}`);
    process.exit(1);
  }

  if (inLinkedWorktree) {
    note("⚠ You're inside a linked worktree. Worktrees are still placed beside the main checkout,");
    note("  but claiming from the main checkout keeps things tidy.");
  }

  // Reuse an existing worktree for this issue rather than failing (resumable).
  if (existsSync(plan.path)) {
    note(`✓ Claimed ${issueId} — worktree already exists, reusing it.`);
    finish(plan.path, plan.branch, issueId, title, claim.claimToken, opts);
    return;
  }

  const add = git(["worktree", "add", plan.path, "-b", plan.branch, base]);
  if (add.status !== 0) {
    const err = (add.stderr || add.stdout || "").trim().split("\n")[0];
    note(`✗ git worktree add failed: ${err}`);
    // The claim succeeded but the worktree didn't — make the held lease actionable.
    note(`  ${issueId} is claimed (yours)${claim.claimToken ? `; claim token: ${claim.claimToken}` : ""}.`);
    if (/already (exists|checked out|used by worktree)/i.test(err)) {
      note(`  The branch already exists — attach without -b: git worktree add ${plan.path} ${plan.branch}`);
    } else {
      // We hold this lease and its token, so name the command that actually works,
      // token included — the caller has no other way to get it once this exits.
      note(
        claim.claimToken
          ? `  Resolve the error and retry, or return it to the pool:\n    retasc release ${issueId} --claim-token ${claim.claimToken}`
          : `  Resolve the error and retry.`,
      );
    }
    process.exit(1);
  }

  note(`✓ Claimed ${issueId}${title ? ` — ${title}` : ""}`);
  note(`  worktree: ${plan.path}`);
  note(`  branch:   ${plan.branch}`);
  // Name the trunk here too: `tidy` prints it, and claim is the other command that
  // acts on it. An unexpected trunk should be visible before the work starts.
  note(`  from:     ${base}`);
  // RTSC-446: a fresh worktree checks out tracked files only — deps/artifacts are absent.
  note(`  Fresh worktree: only tracked files. Run the repo's usual setup (what docs/CI`);
  note(`  run on a fresh checkout) before your first build or test.`);
  finish(plan.path, plan.branch, issueId, title, claim.claimToken, opts);
}

/** Emit machine output / drop into the worktree per the chosen flags. */
function finish(
  path: string,
  branch: string,
  issueId: string,
  title: string | undefined,
  claimToken: string | undefined,
  opts: ClaimOpts,
): void {
  if (opts.json) {
    console.log(JSON.stringify({ issueId, title, branch, path, claimToken }, null, 2));
    return;
  }
  if (opts.printPath) {
    // Only the path on stdout, for `cd "$(retasc claim --print-path)"`.
    console.log(path);
    return;
  }
  if (opts.shell) {
    const shell = process.env.SHELL || "/bin/sh";
    note(`↳ entering ${path} (exit the shell to return)`);
    const r = spawnSync(shell, { stdio: "inherit", cwd: path });
    if (r.error) {
      note(`✗ couldn't start ${shell}: ${r.error.message}`);
      note(`  cd ${path}`);
      process.exit(1);
    }
    if (typeof r.status === "number" && r.status !== 0) process.exit(r.status);
    return;
  }
  note("");
  note(`  cd ${path}`);
}

/**
 * `retasc release <RTSC-NN>` — hand a claimed issue back to the queue (RTSC-691).
 *
 * This command is here because two error paths in this same file already told people to
 * run it (`claim.ts`, the "already held" and "worktree failed" hints) and it did not
 * exist. A CLI that names a command it does not have is worse than one that says nothing:
 * it sends somebody to a dead end at the exact moment they are already stuck.
 *
 * Deliberately does NOT touch git. The worktree and branch may hold real work, and this
 * only returns the LEASE — `retasc tidy` is the command that reaps checkouts, and it
 * refuses to remove anything dirty or unmerged. Keeping the two separate means giving
 * work back is never the thing that loses it.
 */
export async function releaseAction(opts: {
  issueArg?: string;
  id?: string;
  claimToken?: string;
  note?: string;
}): Promise<void> {
  const raw = opts.id ?? opts.issueArg;
  if (!raw) {
    throw new Error("Which issue? Pass one, e.g. `retasc release RTSC-42 --claim-token <token>`.");
  }
  const identifier = normalizeIssueId(raw);
  if (!isValidIssueId(identifier)) {
    throw new Error(`Not an issue id: ${raw}. Expected something like RTSC-42.`);
  }
  // The token is REQUIRED by the server and is not optional here either.
  //
  // `release_issue` is fenced: `assertHolds(issue, claimToken)` proves the caller is the
  // session that actually holds the lease, which is the whole reason one agent cannot
  // release another's work. The CLI does not persist claim tokens anywhere, so it cannot
  // look one up — it prints the token when it claims, and this is where that print gets
  // used. Refusing here, with the reason, beats sending a call the server will reject
  // with a fence error the reader has no context for.
  if (!opts.claimToken) {
    throw new Error(
      `Releasing ${identifier} needs its claim token: \`retasc release ${identifier} --claim-token <token>\`.\n` +
        `  The token is printed when you claim, and is in the \`--json\` output of \`retasc claim\`.\n` +
        `  It proves you are the session holding the lease — without it the server cannot tell\n` +
        `  your release from someone else's, and refuses.`,
    );
  }
  const conn = resolveMcpConn({ mcpJson: readMcpJson() });
  await mcpCall(conn, "release_issue", {
    identifier,
    claimToken: opts.claimToken,
    ...(opts.note ? { note: opts.note } : {}),
  });
  console.log(`✓ Released ${identifier} back to the queue.`);
  console.log("  Its worktree and branch are untouched — `retasc tidy` reaps those.");
}
