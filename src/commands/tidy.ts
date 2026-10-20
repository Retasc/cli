import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { resolveMcpConn, readMcpJson, mcpCall, isValidIssueId, type McpConn } from "../lib/claim.js";
import {
  issueIdFromBranch,
  classifyBranch,
  parseWorktreePorcelain,
  autoCandidates,
  AUTO_MAX,
  type BranchFact,
  type Verdict,
} from "../lib/tidy.js";
import { confirm, isInteractive } from "../lib/prompt.js";
import { doneReadback } from "../lib/format.js";
import { resolveBase, baseHelp, mergedInto, isShallow, type GitRun } from "../lib/base.js";

// `retasc tidy` / `retasc done` (RTSC-93). The CLI already creates the worktree +
// branch on claim (commands/claim.ts); this closes the loop — it tears them down
// when the issue is done, reading status read-only from the control plane and
// doing the git here. The Retasc server never touches git; the CLI is the hands.

function git(args: string[], cwd?: string) {
  return spawnSync("git", args, { encoding: "utf8", cwd });
}
function gitOut(args: string[], cwd?: string): string | null {
  const r = git(args, cwd);
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}
function note(msg: string): void {
  process.stderr.write(msg + "\n");
}

export type TidyOpts = {
  prune?: boolean;
  force?: boolean;
  json?: boolean;
  /** Override the trunk merge state is measured against (default: discovered). */
  base?: string;
  /** Skip the confirmation before a bulk prune (scripts never prompt anyway). */
  yes?: boolean;
  /** Internal: scope the sweep to one issue (used by `retasc done`). */
  only?: string;
  /**
   * Internal: the proxy's unattended sweep (RTSC-1042). Bounds the run to the
   * branches that could actually be reaped, caps it at `AUTO_MAX`, and leaves
   * anything committed to within the grace window alone. Implies `--yes`: there is
   * no human at this end to answer a prompt.
   */
  auto?: boolean;
};

type Row = {
  branch: string;
  issue: string | null;
  status: string | null;
  /** null when git couldn't answer — never reaped, never printed as "no" (RTSC-799). */
  merged: boolean | null;
  verdict: Verdict;
  local: boolean;
  remote: boolean;
  worktree: string | null;
};

type Ctx = {
  conn: McpConn;
  mainCheckout: string;
  currentBranch: string | null;
  run: GitRun;
  /** null when the trunk couldn't be worked out; `baseFailure` then says why. */
  base: string | null;
  baseFailure: { reason: string; tried: string | null } | null;
};
/** A Ctx whose trunk resolved. Everything that measures merge state needs one. */
type ResolvedCtx = Ctx & { base: string };

/** Resolve the MCP connection, the main checkout, and the trunk — or exit with a
 *  clear message. Every exit here happens BEFORE `done` writes a terminal status:
 *  closing an issue and only then discovering the teardown can't run is the worse
 *  of the two failures. */
function setup(baseOpt?: string): Ctx {
  const conn = resolveMcpConn({ mcpJson: readMcpJson() });
  if (!conn.key) {
    note("✗ No Retasc MCP key found. Run `retasc mcp install`, or set RETASC_MCP_KEY.");
    process.exit(1);
  }
  const commonDir = gitOut(["rev-parse", "--git-common-dir"]);
  if (!commonDir) {
    note("✗ Not inside a git repository.");
    process.exit(1);
  }
  // In a BARE repo --git-common-dir is `.`, so this would resolve to the bare repo's
  // PARENT — and every branch delete, worktree remove and `push --delete` below would
  // then run against whatever repository happens to live there. Refuse instead.
  if (gitOut(["rev-parse", "--is-bare-repository"]) === "true") {
    note("✗ This is a bare repository — there are no worktrees or checkouts here to tidy.");
    process.exit(1);
  }
  // --git-common-dir always points at the MAIN checkout's .git, even from a linked
  // worktree — so worktree/branch ops always run against the main checkout.
  const mainCheckout = dirname(resolve(commonDir));
  // symbolic-ref, not `rev-parse --abbrev-ref`: the latter returns the literal string
  // "HEAD" when detached, which would then match no branch and silently disarm the
  // "that's your current branch" guard below.
  const currentBranch = gitOut(["symbolic-ref", "--quiet", "--short", "HEAD"]);

  // RTSC-799: the trunk is discovered, not assumed. An unresolvable one is a hard
  // stop — the alternative it replaces was reporting every branch as unmerged and
  // reaping nothing, for months, with nothing printed to say why.
  const run: GitRun = (args) => {
    const r = git(args, mainCheckout);
    return { status: r.status, stdout: r.stdout ?? "" };
  };
  // Refresh BEFORE resolving. The prune is what deletes `origin/master` after a remote
  // rename, so resolving first would bless a ref this very command is about to remove,
  // and every row would then read "?" against a trunk that no longer exists.
  git(["fetch", "origin", "--prune"], mainCheckout);

  const base = resolveBase(run, baseOpt);
  if (!base.ok) {
    return { conn, mainCheckout, currentBranch, run, base: null, baseFailure: base };
  }
  if (base.staleOriginHead) {
    note(`⚠ origin/HEAD still points at ${base.staleOriginHead}, which is gone. Using ${base.ref}.`);
    note(`  \`git remote set-head origin -a\` re-records it.`);
  }
  // A shallow clone can be missing the very commits ancestry is read from, which
  // produces the same uniform "not merged" this command exists to stop believing.
  // `null` (git couldn't say) warns too: a suppressed warning is the same silence.
  const shallow = isShallow(run);
  if (shallow !== false) {
    note(
      shallow === true
        ? `⚠ Shallow clone — merge state against ${base.ref} may be wrong. \`git fetch --unshallow\` for a true answer.`
        : `⚠ Couldn't tell whether this is a shallow clone; merge state against ${base.ref} may be wrong.`,
    );
  }
  return { conn, mainCheckout, currentBranch, run, base: base.ref, baseFailure: null };
}

/** Short ref names under a refspec (`origin/` stripped when asked). */
function refList(mainCheckout: string, refspec: string, strip?: string): string[] {
  return (gitOut(["for-each-ref", "--format=%(refname:short)", refspec], mainCheckout) ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (strip ? s.replace(strip, "") : s));
}

/** Build the reconciled branch table: every issue-shaped branch (local ∪ remote)
 *  joined with its issue status (read-only) and merged-into-main state. */
async function scan(ctx: ResolvedCtx, only?: string, auto?: boolean): Promise<Row[]> {
  const { conn, mainCheckout } = ctx;

  const worktrees = parseWorktreePorcelain(
    gitOut(["worktree", "list", "--porcelain"], mainCheckout) ?? "",
  );
  const wtByBranch = new Map<string, string>();
  for (const w of worktrees) if (w.branch) wtByBranch.set(w.branch, w.path);

  const locals = refList(mainCheckout, "refs/heads/");
  const remotes = refList(mainCheckout, "refs/remotes/origin/", "origin/").filter((b) => b !== "HEAD");
  const localSet = new Set(locals);
  const remoteSet = new Set(remotes);

  let branches = [...new Set([...locals, ...remotes])]
    .filter((b) => issueIdFromBranch(b) !== null)
    .sort();
  if (only) branches = branches.filter((b) => issueIdFromBranch(b) === only);
  if (branches.length === 0) return [];

  // The GIT facts first, for every branch — they are local and free (RTSC-1042).
  // Merged state used to be computed down in the row map, after a `get_issue` had
  // already been bought for every branch on the machine. It moves up here because in
  // `--auto` it is what decides which branches are worth paying a read for at all.
  const facts: (BranchFact & { remote: boolean })[] = branches.map((branch) => {
    const remote = remoteSet.has(branch);
    // Merged check prefers the remote ref (authoritative); falls back to the local.
    const ref = remote ? `origin/${branch}` : branch;
    return {
      branch,
      remote,
      merged: mergedInto(ctx.run, ref, ctx.base),
      // Fully pushed = every local commit is already on the branch's own origin ref.
      // Only meaningful when there IS one; `mergedInto` returns null if the ref is
      // missing, which reads as "not pushed" everywhere downstream. Local git, free.
      pushed: remote ? mergedInto(ctx.run, branch, `origin/${branch}`) === true : false,
      lastCommitAt: lastCommitMs(ctx.run, ref),
    };
  });

  // In `--auto`, drop everything that could not be reaped whatever its status turns
  // out to be, and cap what is left: a branch that is neither merged nor fully pushed
  // is one whose commits exist nowhere else, and no status makes that deletable. A
  // human's `tidy` still sees every branch: they asked for the table, and the table is
  // the point.
  const considered = auto ? (autoCandidates(facts, Date.now()) as typeof facts) : facts;

  for (const f of considered) {
    // The base already resolved, so an unknown here is the ref itself — say so
    // rather than letting a "no" in the table stand in for a failed check.
    if (f.merged === null) {
      const ref = f.remote ? `origin/${f.branch}` : f.branch;
      note(`⚠ ${f.branch}: git couldn't compare ${ref} against ${ctx.base} — treating it as unmerged.`);
    }
  }

  // Read issue statuses — read-only against the control plane, one per unique id.
  const uniqueIds = [...new Set(considered.map((f) => issueIdFromBranch(f.branch)!))];
  const statusById = new Map<string, string | null>();
  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const issue = (await mcpCall(conn, "get_issue", { identifier: id })) as any;
        statusById.set(id, typeof issue?.status === "string" ? issue.status : null);
      } catch {
        statusById.set(id, null); // not found / error → untracked, never reaped
      }
    }),
  );

  return considered.map((f): Row => {
    const issue = issueIdFromBranch(f.branch);
    const status = issue ? (statusById.get(issue) ?? null) : null;
    return {
      branch: f.branch,
      issue,
      status,
      merged: f.merged,
      verdict: classifyBranch({ status, merged: f.merged }),
      local: localSet.has(f.branch),
      remote: f.remote,
      worktree: wtByBranch.get(f.branch) ?? null,
    };
  });
}

/**
 * When a ref was last committed to, in epoch MILLISECONDS — or undefined if git
 * couldn't say. Feeds the sweep's grace window (see `AUTO_GRACE_MS`); `%ct` is in
 * seconds, so it is scaled here rather than at the comparison, where the unit
 * mismatch would be silent and would read as "committed in 1970".
 */
function lastCommitMs(run: GitRun, ref: string): number | undefined {
  const r = run(["log", "-1", "--format=%ct", ref]);
  if (r.status !== 0) return undefined;
  const secs = Number((r.stdout ?? "").trim());
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/** Ask once before a prune this large. See the call site for why. */
const BULK_CONFIRM_AT = 5;

const VERDICT_LABEL: Record<Verdict, string> = {
  reap: "reap",
  orphan: "orphan — review",
  active: "active — keep",
  untracked: "untracked",
};

function printTable(rows: Row[]): void {
  const w = Math.max(...rows.map((r) => r.branch.length), 6);
  note(`  ${"branch".padEnd(w)}  issue      status     merged  verdict`);
  for (const r of rows) {
    note(
      `  ${r.branch.padEnd(w)}  ${(r.issue ?? "—").padEnd(9)}  ${(r.status ?? "—").padEnd(9)}  ` +
        `${(r.merged === null ? "?" : r.merged ? "yes" : "no").padEnd(6)}  ${VERDICT_LABEL[r.verdict]}`,
    );
  }
}

/** Delete one branch's artifacts (worktree → local branch → remote branch),
 *  refusing anything unsafe. Returns whether it acted. */
function reap(
  row: Row,
  ctx: ResolvedCtx,
  force: boolean,
  /**
   * RTSC-1042 — leave the branch on `origin` alone. Set by the unattended sweep.
   *
   * Every other guard in this file reasons about THIS MACHINE: is the tree clean, is
   * the branch merged here, am I standing in it. None of them can see whether another
   * developer's checkout or a CI job still wants that remote ref, and the sweep runs
   * with nobody watching — so the one action with a blast radius beyond this laptop is
   * the one it does not get to take. The trade is also lopsided: deleting the worktree
   * reclaims ~450 MB, which is the entire complaint, and deleting the remote ref
   * reclaims a few bytes of shared state. Local cleanup is per-machine and cheap to
   * undo; a remote delete is everyone's, and the person who caused it is not the person
   * who has to work out which SHA to restore.
   *
   * Remote refs stay a deliberate act: a human `retasc tidy --prune`, or GitHub's own
   * "automatically delete head branches" setting, which is built for exactly this.
   */
  keepRemote = false,
): "deleted" | "skipped" | "failed" {
  const { mainCheckout, currentBranch } = ctx;

  if (row.branch === currentBranch) {
    note(`  · skip ${row.branch} — it's your current branch (cd elsewhere to remove it)`);
    return "skipped";
  }

  // `row.merged` was computed from the REMOTE ref, but we force-delete the LOCAL
  // branch below. If the local branch carries commits not yet on the trunk
  // (committed-but-unpushed), skip unless --force — so `branch -D` can't silently
  // discard them. (--force is the consented escape hatch.) An unknown answer skips
  // for the same reason a "no" does: only a proven-landed branch gets deleted.
  if (row.local && !force) {
    // RTSC-1042 — the question this guard is really asking is "can these commits be
    // recovered if I am wrong?", and merged-into-the-trunk is not the only yes.
    //
    // A branch whose every commit is already on its own `origin/` ref is restorable
    // with one `git checkout -b`, and the unattended sweep no longer deletes remote
    // refs, so origin is a genuine backup rather than a hope. Asking only about the
    // trunk made a fully pushed, explicitly CANCELED branch undeletable forever, while
    // a branch that exists nowhere but this disk is the only one that truly cannot be
    // undone — and both were being refused for the same reason.
    //
    // Unknown still means no, on both arms: an unanswerable check never authorizes a
    // delete (RTSC-799).
    const localOnBase = mergedInto(ctx.run, row.branch, ctx.base);
    if (localOnBase !== true) {
      const onOrigin = row.remote ? mergedInto(ctx.run, row.branch, `origin/${row.branch}`) : null;
      if (onOrigin !== true) {
        note(
          localOnBase === null
            ? `  · skip ${row.branch} — couldn't check its local branch against ${ctx.base}`
            : `  · skip ${row.branch} — commits are not on ${ctx.base} and not pushed to origin; --force to delete`,
        );
        return "skipped";
      }
    }
  }

  if (row.worktree) {
    const insideTarget =
      resolve(process.cwd()) === resolve(row.worktree) ||
      resolve(process.cwd()).startsWith(resolve(row.worktree) + sep);
    if (insideTarget) {
      note(`  · skip ${row.branch} — you're inside its worktree; cd out and re-run`);
      return "skipped";
    }
    // Distinguish "clean" from "couldn't determine": a null (git error / stale
    // path) must NOT read as clean. `worktree remove` (no --force) is the backstop.
    const st = gitOut(["status", "--porcelain"], row.worktree);
    if (st === null) {
      note(`  · skip ${row.branch} — couldn't read its worktree state (${row.worktree})`);
      return "skipped";
    }
    if (st !== "") {
      note(`  · skip ${row.branch} — worktree has uncommitted changes (${row.worktree})`);
      return "skipped";
    }
    const rm = git(["worktree", "remove", row.worktree], mainCheckout);
    if (rm.status !== 0) {
      note(`  ✗ ${row.branch}: worktree remove failed — ${(rm.stderr || "").trim().split("\n")[0]}`);
      return "failed";
    }
  }

  // -D is safe here: either the local branch is on the trunk (verified above) or
  // the user passed --force. `--` guards against any future caller bypassing the
  // issueIdFromBranch filter (the regex already forbids leading-dash names).
  if (row.local) {
    const d = git(["branch", "-D", "--", row.branch], mainCheckout);
    if (d.status !== 0) {
      note(`  ✗ ${row.branch}: local delete failed — ${(d.stderr || "").trim().split("\n")[0]}`);
      return "failed";
    }
  }

  // Origin delete only when the work is on the trunk. `--auto` never deletes
  // remotes (keepRemote). Human / on-close tidy used to origin-delete a
  // canceled-but-unmerged branch — that was the only shared copy. merged !== true
  // means it never landed; leave origin alone.
  if (row.remote && (keepRemote || row.merged !== true)) {
    note(
      keepRemote
        ? `  · ${row.branch}: local only — its branch on origin is left for a human \`retasc tidy\``
        : `  · ${row.branch}: local only — not on ${ctx.base}, origin kept`,
    );
  } else if (row.remote) {
    const p = git(["push", "origin", "--delete", row.branch], mainCheckout);
    if (p.status !== 0) {
      note(`  ✗ ${row.branch}: remote delete failed — ${(p.stderr || "").trim().split("\n")[0]}`);
      return "failed";
    }
  }

  note(`  ✓ reaped ${row.branch}`);
  return "deleted";
}

/**
 * `retasc tidy` — reconcile every `rtsc-NN/*` branch against its issue status and
 * merged-state, then (with --prune) delete the ones whose work is done and on
 * main. Dry-run by default. Orphans (done but unmerged) are only deleted with
 * --force; untracked branches (no matching issue) are never touched.
 */
export async function tidyAction(opts: TidyOpts): Promise<void> {
  const ctx = setup(opts.base);
  // `tidy`'s entire job is merge state, so it has nothing to say without a trunk.
  // (`done` treats the same failure as non-fatal: its write is the durable half.)
  if (ctx.base === null) {
    for (const line of baseHelp(ctx.baseFailure!)) note(line);
    process.exit(1);
  }
  const resolved = ctx as ResolvedCtx;

  // RTSC-1042 — clear the metadata of worktrees whose DIRECTORY is already gone, before
  // anything reads the list.
  //
  // These are invisible to every other path here and self-perpetuating. `reap` asks a
  // tree for `git status --porcelain`; on a missing path that answers null, which is
  // correctly read as "couldn't tell" and skips — and it skips BEFORE the branch delete,
  // so the branch never goes either. The entry stays in `git worktree list` forever,
  // holding a merged branch nothing will ever remove. On the machine this issue was
  // measured from there were seven, four of them on merged rtsc branches.
  //
  // `git worktree prune` is the operation built for exactly this, and it is the safe
  // one: it removes administrative files for worktrees whose directory no longer
  // exists, and it cannot touch a tree that is still on disk. Running it FIRST means
  // the scan below sees the truth, and those branches become ordinary branch-only rows
  // that the normal reap can judge on merge state like any other.
  //
  // Gated on --prune because a bare `tidy` is a dry run and must not mutate anything,
  // even metadata.
  if (opts.prune) {
    // `-v` reports what it removed on STDERR, not stdout (checked, not assumed), so this
    // reads `stderr` — `gitOut` would return an empty string here and the count would
    // silently always be zero.
    const pruned = git(["worktree", "prune", "-v"], resolved.mainCheckout);
    const removed = (pruned.stderr ?? "").split("\n").filter((l) => l.trim()).length;
    if (removed) {
      note(`· pruned ${removed} worktree record${removed === 1 ? "" : "s"} whose directory was already gone`);
    }
  }

  const rows = await scan(resolved, opts.only, opts.auto);

  if (rows.length === 0) {
    note(opts.only ? `· No branch found for ${opts.only}.` : "· No issue branches (rtsc-NN/…) found.");
    return;
  }

  // Name the trunk every run. Without it "merged: no" is unfalsifiable from the
  // outside, which is precisely how RTSC-799 survived for months.
  note(`· merged is measured against ${resolved.base}`);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }

  const reapable = rows.filter((r) => r.verdict === "reap");
  const orphans = rows.filter((r) => r.verdict === "orphan");
  // --force means "unmerged, but I know the work landed elsewhere" — a judgement about
  // a branch whose state git DID report. A row git couldn't judge at all is not that,
  // and deleting it would make this file's own rule ("an unknown can never authorize a
  // delete") false. Those need the ref fixed, not a bigger hammer.
  const unknown = orphans.filter((r) => r.merged === null);
  const forceable = orphans.filter((r) => r.merged !== null);
  const targets = [...reapable, ...(opts.force ? forceable : [])];

  if (!opts.prune) {
    note("");
    const n = reapable.length;
    note(
      n
        ? `→ ${n} branch${n === 1 ? "" : "es"} reapable. Run \`retasc tidy --prune\` to delete${orphans.length ? `, \`--force\` to also clear ${orphans.length} orphan(s)` : ""}.`
        : orphans.length
          ? `→ no clean reaps; ${orphans.length} orphan(s) need review (done but unmerged) — \`--prune --force\` to delete.`
          : "→ nothing to reap.",
    );
    return;
  }

  if (targets.length === 0) {
    note("");
    note(forceable.length ? "→ only orphans remain; re-run with --force to delete them." : "→ nothing to reap.");
    if (unknown.length) note(`→ ${unknown.length} branch(es) git couldn't judge are left alone, even with --force.`);
    return;
  }

  // The first --prune after upgrading can be enormous: this command was a silent no-op
  // in every repo whose trunk wasn't `main`, so a team can be sitting on months of
  // branches it never reaped. Deleting all of them on one keystroke, against a mental
  // model that says --prune does nothing, is not a fix. Scripts never see this (no TTY),
  // and the proxy's auto-reap passes --only, so it is always a single branch.
  if (!opts.only && !opts.yes && !opts.auto && isInteractive() && targets.length >= BULK_CONFIRM_AT) {
    note("");
    const remotes = targets.filter((t) => t.remote).length;
    note(`About to delete ${targets.length} branches (${remotes} also on origin) and their worktrees.`);
    if (!(await confirm("Delete them?"))) {
      note("· Nothing deleted.");
      return;
    }
  }

  note("");
  let deleted = 0;
  let failed = 0;
  for (const row of targets) {
    const r = reap(row, resolved, !!opts.force, !!opts.auto);
    if (r === "deleted") deleted++;
    else if (r === "failed") failed++;
  }
  note(`✓ reaped ${deleted} branch${deleted === 1 ? "" : "es"}.${failed ? ` ${failed} failed.` : ""}`);
  // Say so when the cap bit, or a machine with fifty dead trees looks like one the
  // sweep only half-understands. It drains at AUTO_MAX a session until it is clean.
  if (opts.auto && rows.length >= AUTO_MAX) {
    note(`· capped at ${AUTO_MAX} branches this run — the next session picks up where this left off.`);
  }
  if (failed) process.exitCode = 1; // let scripts/CI see a partial failure
}

export type DoneOpts = { id?: string; force?: boolean; yes?: boolean; dryRun?: boolean; base?: string };

/**
 * Is every branch for this issue already on the trunk? null when it has no branch here.
 *
 * Pessimistic on purpose: if ANY branch for the issue is unmerged — or can't be checked —
 * this says unmerged. The readback exists to stop a close over open work, so the cautious
 * answer is the true one.
 */
function issueBranchMerged(ctx: ResolvedCtx, issueId: string): boolean | null {
  const locals = refList(ctx.mainCheckout, "refs/heads/");
  const remotes = refList(ctx.mainCheckout, "refs/remotes/origin/", "origin/").filter((b) => b !== "HEAD");
  const remoteSet = new Set(remotes);
  const branches = [...new Set([...locals, ...remotes])].filter((b) => issueIdFromBranch(b) === issueId);
  if (branches.length === 0) return null;
  return branches.every((b) => mergedInto(ctx.run, remoteSet.has(b) ? `origin/${b}` : b, ctx.base) === true);
}

/**
 * `retasc done` — the symmetric close to `retasc claim`: mark the current issue
 * (from the `rtsc-NN/` branch, or --id) done, then tear down its worktree+branch.
 * Run it after the PR merges; an unmerged branch is kept (reported as an orphan)
 * unless you pass --force. Run from the main checkout for full teardown — from
 * inside the worktree it can't remove the tree you're standing in.
 *
 * RTSC-709 — it reads the issue back and asks before closing it. This command writes a
 * terminal status from a single word, and it shipped with nothing in front of that write:
 * a stray `retasc done` closed RTSC-706 while its PR was open and unreviewed, printed a
 * tick, and went on to offer branch deletion. `tidy` already asks before it deletes a
 * branch; closing an issue is the less reversible of the two.
 *
 * The prompt is skipped when stdin is not a TTY, so scripts and CI keep working exactly as
 * before — the accident this guards against is a human typing a word, and a pipeline that
 * hangs on a question nobody can answer is a worse failure than the one being fixed.
 */
export async function doneAction(opts: DoneOpts): Promise<void> {
  // setup() resolves the MCP key AND the main checkout. Both are needed either way, and
  // failing on a missing repo BEFORE the write beats closing the issue and then finding
  // the teardown can't run.
  const ctx = setup(opts.base);
  // Normalize an explicit --id to the canonical uppercase form so `done --id rtsc-93`
  // matches the uppercased branch ids (and is sent canonically to save_issue).
  const issueId = opts.id
    ? opts.id.toUpperCase()
    : ctx.currentBranch
      ? issueIdFromBranch(ctx.currentBranch)
      : null;
  if (!issueId || !isValidIssueId(issueId)) {
    note("✗ Not on a rtsc-NN/ branch — pass --id <RTSC-NN>.");
    process.exit(1);
  }

  // (setup() already fetched: a stale trunk reports merged work as unmerged, which is
  // the warning that teaches people to ignore the warning.)
  let issue: any = null;
  try {
    issue = await mcpCall(ctx.conn, "get_issue", { identifier: issueId });
  } catch (e) {
    // A failed read must not become a silent close. Say so, and let the confirmation
    // below carry the decision with what little is known.
    note(`⚠ Couldn't read ${issueId}: ${String((e as any)?.message ?? e).split("\n")[0]}`);
  }
  // An unresolvable trunk is NOT fatal here, deliberately. The control-plane close is
  // the durable half of `done`; the git teardown is local best-effort. Refusing to close
  // an issue because a checkout has no origin/HEAD — which is exactly what a CI clone
  // looks like — would break the scripts this command promises to keep working. So say
  // what couldn't be checked, and let the human decide with that in front of them.
  if (ctx.base === null) {
    note(`⚠ Can't tell whether the branch merged: ${ctx.baseFailure!.reason}.`);
    note(`  Closing is still fine; the branch teardown below is what needs a trunk.`);
  }
  const resolved = ctx.base === null ? null : (ctx as ResolvedCtx);
  note(
    doneReadback(
      { ...(issue ?? {}), id: issueId },
      resolved ? issueBranchMerged(resolved, issueId) : null,
      ctx.base ?? "the trunk",
    ),
  );

  if (opts.dryRun) {
    note("");
    note(`· Dry run: ${issueId} was NOT closed. Below is what the teardown would do.`);
    note("");
    await tidyAction({ force: opts.force, base: ctx.base ?? undefined, only: issueId });
    return;
  }

  // Already done: go straight to the teardown. Re-sending the write would cost a metered
  // write and bump updatedAt to say something changed when nothing did.
  if (issue?.status === "done") {
    note("");
    note(`· ${issueId} is already done; tidying its branch.`);
  } else {
    if (isInteractive() && !opts.yes) {
      note("");
      if (!(await confirm(`Close ${issueId} and tear down its branch?`))) {
        note("· Nothing closed.");
        return;
      }
    }
    try {
      await mcpCall(ctx.conn, "save_issue", { identifier: issueId, status: "done" });
    } catch (e) {
      note(`✗ Couldn't mark ${issueId} done: ${String((e as any)?.message ?? e).split("\n")[0]}`);
      process.exit(1);
    }
    note(`✓ ${issueId} → done`);
  }
  note("  tidying its branch…");
  await tidyAction({ prune: true, force: opts.force, base: ctx.base ?? undefined, only: issueId });
}
