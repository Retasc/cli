// Pure helpers for `retasc tidy` / `retasc done` (RTSC-93). Side-effect-free
// (no git, no network) so branch→issue parsing, verdict classification, and the
// worktree-porcelain parse can be unit-tested. The git + API work lives in
// ../commands/tidy.ts.
//
// The principle: detecting a stale branch is a JOIN of two facts — the issue's
// status (Retasc / control plane, read-only) and whether the branch is merged
// (git / execution plane). This file is just the join logic; it owns no state.

/**
 * The issue id embedded in a `rtsc-NN/<slug>` branch name, normalized to the
 * uppercase id (`rtsc-37/foo` → `RTSC-37`). Returns null for branches that don't
 * follow the convention (`main`, `hotfix/x`, a bare `rtsc-37` with no slash) —
 * those are never matched, so they can never be auto-deleted. Generic over the
 * prefix, so it also matches `xen-12/…`.
 */
export function issueIdFromBranch(branch: string): string | null {
  const m = branch.match(/^([a-z][a-z0-9]*)-(\d+)\//);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

export type Verdict = "reap" | "orphan" | "active" | "untracked";

/**
 * Decide what to do with a branch from the join of issue status (control plane)
 * and merged-into-the-trunk (execution plane):
 *   - done/canceled + merged   → reap     (safe to delete; work is on the trunk)
 *   - done/canceled + unmerged → orphan   (review — work may have landed elsewhere)
 *   - todo/doing/blocked       → active   (keep — work in progress)
 *   - no matching issue        → untracked (report only — never auto-delete)
 * `status` is null when no issue maps to the branch (off-convention name, or the
 * issue wasn't found).
 *
 * `merged` is null when git couldn't answer (RTSC-799). Only an explicit `true`
 * reaps: "couldn't tell" must never authorize a delete, and it lands in the same
 * needs-a-human bucket as a genuinely unmerged branch.
 */
export function classifyBranch(opts: { status: string | null; merged: boolean | null }): Verdict {
  const { status, merged } = opts;
  if (status === null) return "untracked";
  // RTSC-1042 — `canceled` and `done` are NOT the same answer for an unmerged branch,
  // and treating them as one is why a canceled issue's worktree lived forever.
  //
  //   done + unmerged   → the PR is probably open and a human merges it later. That is
  //                       this issue's entire story, and deleting it would be wrong.
  //   canceled + unmerged → nobody is ever going to merge it. The control plane has
  //                       said, explicitly, that the work is not wanted.
  //
  // So canceled is reapable on the control plane's say-so alone, merged or not. That is
  // a verdict about the WORK, not a licence to destroy commits: `reap` still refuses
  // any branch whose commits exist nowhere else, which is the check that actually
  // prevents loss.
  // The one thing canceled does NOT override is an unanswerable merge check. RTSC-799
  // left a principle behind — an unknown can never authorize a delete — and `null` here
  // means git could not compare the refs at all: a shallow clone, a missing ref, a repo
  // in a state nobody predicted. "The work was canceled" is a fact about the work; it
  // says nothing about whether this repo is currently legible enough to act on. When
  // git is confused, a destructive path should do less, not more.
  if (status === "canceled") return merged === null ? "orphan" : "reap";
  if (status === "done") return merged === true ? "reap" : "orphan";
  return "active";
}

export type Worktree = { path: string; branch: string | null };

/**
 * Parse `git worktree list --porcelain` into {path, branch}. Entries are blank-
 * line separated; each starts with `worktree <path>`, and a `branch refs/heads/x`
 * line names its branch (absent for detached worktrees).
 */
export function parseWorktreePorcelain(out: string): Worktree[] {
  return out
    .split(/\n\n+/)
    .map((block): Worktree | null => {
      const lines = block.split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      if (!pathLine) return null;
      const branchLine = lines.find((l) => l.startsWith("branch "));
      const branch = branchLine
        ? branchLine.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
        : null;
      return { path: pathLine.slice("worktree ".length).trim(), branch };
    })
    .filter((w): w is Worktree => w !== null);
}

// ── RTSC-1042: the automatic sweep's candidate filter ────────────────────────
//
// `tidy` invoked by a human is exhaustive: it lists every issue-shaped branch and
// resolves every status, because a person asked to see the table. The proxy's
// automatic sweep cannot be exhaustive, for a reason that is easy to miss and
// expensive to discover in production: `scan` pays ONE `get_issue` per unique issue
// id, and a read is 1,000 µUSDC. On the machine this issue was measured from, 69
// issue-shaped branches would bill ~$0.069 per sweep — every session, forever, and
// the bill would grow with exactly the mess the sweep exists to remove. A cleanup
// that gets more expensive the more there is to clean is not a cleanup.
//
// So the sweep spends the FREE facts first. Merge state and push state both come from
// local git and cost nothing, and a branch that is neither merged nor fully pushed can
// never be reaped whatever its status turns out to be — so paying to learn that status
// is pure waste. Filter on the free facts, cap what survives, and only then buy the
// statuses. That makes the sweep's cost bounded and CONSTANT (at most AUTO_MAX reads)
// no matter how many dead trees are on the machine.

/**
 * How many branches one automatic sweep may consider — and therefore the most reads
 * it can ever cost, and the most worktrees it can ever delete in one run.
 *
 * The cap is two things at once, deliberately. It bounds the bill (above), and it
 * bounds the blast radius: the first sweep on a machine that has been accumulating
 * for months meets dozens of dead trees, and deleting all of them in one unattended
 * pass is a lot of destruction to do silently on the strength of a judgement no
 * human has reviewed yet. At ten per session the backlog still drains in a few
 * sittings, each run's log is short enough to actually read, and a mistake in this
 * logic costs ten directories that git can restore from the trunk rather than all of
 * them at once.
 */
export const AUTO_MAX = 10;

/**
 * How recently a branch must have been committed to for the sweep to leave it alone,
 * even when its issue is closed and its work is merged.
 *
 * This is the one thing `classifyBranch` cannot see. Its inputs are the issue's
 * status and the branch's merge state, and both can be fully satisfied while an agent
 * is still SITTING in that directory — it marked the issue done, a human merged the
 * PR minutes later, and the session is now writing its summary. Removing the tree
 * under a live process changes its cwd out from under it mid-run.
 *
 * An hour rather than `worktreeReport`'s 24: that window answers "is someone working
 * here?", where a false negative wrongly withholds an issue from dispatch and the
 * generous answer is right. This one answers "did someone just finish?", where the
 * done-and-merged-and-clean evidence is already strong and 24 hours would defer
 * nearly every reap to the following day for no gain.
 */
export const AUTO_GRACE_MS = 60 * 60 * 1000;

/** What the sweep knows about a branch before it has paid for anything. */
export type BranchFact = {
  branch: string;
  /** From `mergedInto` — `null` means git couldn't say, which never authorizes anything. */
  merged: boolean | null;
  /** `git log -1 --format=%ct` in epoch MILLISECONDS, or undefined if git couldn't say. */
  lastCommitAt?: number;
  /**
   * Is every local commit on this branch also on its `origin/` ref?
   *
   * The recoverability fact, and the reason an unmerged branch can be a candidate at
   * all. `merged` answers "can these commits be recovered?" with a yes, but it is not
   * the only yes — a fully pushed branch can be restored with one `git checkout -b`,
   * and the sweep no longer deletes remote refs, so origin is a real backup. Undefined
   * or false means: assume nothing, and never authorize a delete on it.
   */
  pushed?: boolean;
};

/**
 * The branches an automatic sweep should pay to resolve, newest-dead last.
 *
 * Keeps only what could actually be reaped: merged for certain, and not touched
 * inside the grace window. An unknown `lastCommitAt` is treated as OLD rather than
 * fresh — the grace window protects a tree an agent is standing in, and a tree git
 * cannot date is one with no commits on it to stand on; the real guards against
 * deleting live work (status, dirtiness, current branch, unpushed commits) all run
 * later in `reap` and none of them is weakened by this ordering.
 *
 * Oldest first, so when the cap bites it bites on the most recently finished work —
 * the trees most likely to still have somebody near them.
 */
export function autoCandidates(facts: BranchFact[], now: number, max = AUTO_MAX): BranchFact[] {
  return facts
    .filter((f) => f.merged === true || (f.merged === false && f.pushed === true))
    .filter((f) => f.lastCommitAt === undefined || now - f.lastCommitAt >= AUTO_GRACE_MS)
    // Merged first, then oldest first inside each group. This is what keeps the widened
    // filter free: the CAP is unchanged, so the sweep still costs at most `max` reads —
    // the unmerged probes only ever use slots the merged backlog did not need. A machine
    // buried in dead merged trees clears those first and never pays to ask about a
    // branch that is probably just waiting on a PR.
    .sort((a, b) => {
      if ((a.merged === true) !== (b.merged === true)) return a.merged === true ? -1 : 1;
      return (a.lastCommitAt ?? 0) - (b.lastCommitAt ?? 0);
    })
    .slice(0, max);
}
