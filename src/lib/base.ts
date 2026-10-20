// Which ref is this repo's trunk? (RTSC-799)
//
// `tidy` and `done` decide whether a branch's work has landed by asking git
// whether it's an ancestor of the trunk, and `claim` branches from the trunk.
// All three used to spell that trunk `origin/main`, written into the source with
// no way to change it. In a repo whose default branch is `master` the comparison
// doesn't error into view — `merge-base --is-ancestor` exits 128, the caller only
// tested for 0, and every branch came back "not merged". Nothing was ever
// reapable, so `claim` kept minting worktrees that nothing ever removed. One
// customer accumulated thirty of them over months with no error printed once.
//
// So two rules live here, and they're the whole point of the file:
//   1. The trunk is DISCOVERED (origin/HEAD, the same thing `git clone` records),
//      overridable per-repo, and never assumed.
//   2. A git failure is never an answer. `merge-base --is-ancestor` has three
//      outcomes and this module returns three, so "couldn't tell" can't wear the
//      same face as "no".
//
// The decision (`pickBase`) is pure and takes the repo's facts as data, so the
// precedence order is testable without a git fixture; `resolveBase` is the thin
// layer that gathers those facts.

/**
 * Per-repo override: `git config retasc.base origin/develop`.
 *
 * Read at `--local` scope ONLY, and deliberately. A plain `git config --get` also
 * sees ~/.gitconfig, so one global value would redefine the trunk in every repo on
 * the machine and outrank each repo's own origin/HEAD — and the trunk is the only
 * evidence behind `git branch -D` / `git push origin --delete`, which the proxy runs
 * unattended on every terminal close. A machine-wide answer to a per-repo question
 * is not a default, it is a footgun.
 */
export const BASE_CONFIG_KEY = "retasc.base";

/** How `git` gets run. Injected so this module is testable and cwd-agnostic. */
export type GitRun = (args: string[]) => { status: number | null; stdout: string };

export type BaseSource = "flag" | "config" | "origin-head" | "remote-default" | "local-default";

export type BaseInputs = {
  /** `--base`, if the caller passed one. */
  explicit?: string | null;
  /** `git config retasc.base`, if set. */
  configured?: string | null;
  /** What `origin/HEAD` points at, short form (`origin/master`), if it's a symref. */
  originHead?: string | null;
  /** Whether the repo has an `origin` remote at all. */
  hasOrigin: boolean;
  /** Which of `origin/main`, `origin/master` actually exist. */
  remoteCandidates: string[];
  /** Which of `main`, `master` actually exist locally. */
  localCandidates: string[];
};

export type BasePick =
  | { ok: true; ref: string; source: BaseSource }
  | { ok: false; reason: string };

/**
 * Choose the trunk from what the repo already knows, most explicit first:
 * `--base` → `git config retasc.base` → `origin/HEAD` → the one of
 * `origin/{main,master}` that exists → for a repo with no remote, the one of
 * `main`/`master` that exists.
 *
 * Ambiguity is a failure, never a guess. A repo carrying BOTH `origin/main` and
 * `origin/master` with no `origin/HEAD` to break the tie gets an error naming the
 * two, because picking the wrong one here doesn't misreport one row — it silently
 * reclassifies every branch in the repo.
 */
export function pickBase(i: BaseInputs): BasePick {
  // Only ABSENT skips. An empty `--base "$UNSET_VAR"` must not quietly become
  // "discover one for me" and then measure deletions against a trunk the caller
  // never named — the sibling rule claim.ts already spells out for issue ids.
  if (i.explicit != null && i.explicit.trim() === "") {
    return { ok: false, reason: "--base was given an empty value" };
  }
  if (i.configured != null && i.configured.trim() === "") {
    return { ok: false, reason: `git config ${BASE_CONFIG_KEY} is set to an empty value` };
  }
  if (i.explicit) return { ok: true, ref: i.explicit, source: "flag" };
  if (i.configured) return { ok: true, ref: i.configured, source: "config" };
  if (i.originHead) return { ok: true, ref: i.originHead, source: "origin-head" };

  if (i.hasOrigin) {
    if (i.remoteCandidates.length === 1) {
      return { ok: true, ref: i.remoteCandidates[0]!, source: "remote-default" };
    }
    if (i.remoteCandidates.length > 1) {
      return {
        ok: false,
        reason: `origin has both ${i.remoteCandidates.join(" and ")}, and no origin/HEAD to say which is the trunk`,
      };
    }
    return {
      ok: false,
      reason: "origin has no recorded default branch (no origin/HEAD), and neither origin/main nor origin/master exists",
    };
  }

  if (i.localCandidates.length === 1) {
    return { ok: true, ref: i.localCandidates[0]!, source: "local-default" };
  }
  if (i.localCandidates.length > 1) {
    return { ok: false, reason: `this repo has no origin remote, and both ${i.localCandidates.join(" and ")} exist locally` };
  }
  return { ok: false, reason: "this repo has no origin remote, and neither main nor master exists locally" };
}

export type BaseResult =
  | {
      ok: true;
      ref: string;
      source: BaseSource;
      /** Set when origin/HEAD named a ref that's gone and we fell through past it. */
      staleOriginHead?: string;
    }
  | { ok: false; reason: string; tried: string | null };

/**
 * Read the repo and pick its trunk, then PROVE the pick resolves to a commit.
 *
 * The proof matters as much as the pick: a `--base` for a ref that isn't there would
 * otherwise fail later as "nothing is merged", the exact silence this exists to end.
 * `tried` carries the ref that didn't resolve so the caller can name it.
 */
export function resolveBase(run: GitRun, explicit?: string | null): BaseResult {
  const out = (args: string[]): string | null => {
    const r = run(args);
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  const resolves = (ref: string) => run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;

  /** What the repo's own refs say, or null when `git remote` couldn't be read. */
  const discover = (): Pick<BaseInputs, "hasOrigin" | "remoteCandidates" | "localCandidates"> | null => {
    // One for-each-ref for all four candidates. Full refnames, not short ones: a
    // local branch literally named `origin/main` would otherwise read as the remote.
    const refs = (
      out([
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
      ]) ?? ""
    )
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    // A FAILED `git remote` must not read as "no origin". That would route the pick to
    // the local candidates and hand back a local `main`/`master` as the trunk that
    // REMOTE branch deletion is then measured against. No remotes at all is exit 0 with
    // empty output, so the two are distinguishable — keep them distinguished.
    const remotes = out(["remote"]);
    if (remotes === null) return null;
    return {
      hasOrigin: remotes.split("\n").some((r) => r.trim() === "origin"),
      remoteCandidates: ["main", "master"]
        .filter((b) => refs.includes(`refs/remotes/origin/${b}`))
        .map((b) => `origin/${b}`),
      localCandidates: ["main", "master"].filter((b) => refs.includes(`refs/heads/${b}`)),
    };
  };

  // --get-all, not --get: with two values `--get` silently returns the last one. The
  // trunk is the evidence behind a delete, so an ambiguous answer is no answer.
  const configured = explicit ? null : out(["config", "--local", "--get-all", BASE_CONFIG_KEY]);
  if (configured !== null && configured.split("\n").filter((l) => l.trim()).length > 1) {
    return { ok: false, reason: `git config ${BASE_CONFIG_KEY} has more than one value`, tried: null };
  }
  const originHead =
    explicit || configured ? null : out(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);

  // Only inspect the repo's refs when nothing more explicit answered. Beyond being
  // cheaper, it means a repo whose `git remote` is unreadable still works when the
  // caller named the trunk outright.
  let inputs: BaseInputs;
  if (explicit != null || configured != null || originHead) {
    inputs = { explicit, configured, originHead, hasOrigin: false, remoteCandidates: [], localCandidates: [] };
  } else {
    const found = discover();
    if (!found) return { ok: false, reason: "git couldn't list this repo's remotes", tried: null };
    inputs = found;
  }

  const pick = pickBase(inputs);
  if (!pick.ok) return { ok: false, reason: pick.reason, tried: null };
  if (resolves(pick.ref)) return { ok: true, ref: pick.ref, source: pick.source };

  // An INFERRED pick that doesn't resolve falls through; an explicit one does not.
  // `origin/HEAD` outlives the branch it names: rename the trunk on the remote and the
  // symref still reports the deleted `origin/master`, and git older than 2.45 never
  // repairs it on fetch. Hard-failing there would refuse `claim`, `tidy` AND `done` in a
  // repo that is otherwise perfectly healthy, which is a worse outage than the silence
  // this file exists to end. A ref the CALLER named is different: they asked for that one,
  // so a typo gets reported rather than quietly worked around.
  if (pick.source === "origin-head") {
    const found = discover();
    const second = found ? pickBase(found) : { ok: false as const, reason: "" };
    if (second.ok && resolves(second.ref)) {
      return { ok: true, ref: second.ref, source: second.source, staleOriginHead: pick.ref };
    }
  }
  return { ok: false, reason: `${pick.ref} (${sourceLabel(pick.source)}) doesn't resolve to a commit`, tried: pick.ref };
}

function sourceLabel(s: BaseSource): string {
  return s === "flag"
    ? "from --base"
    : s === "config"
      ? `from git config ${BASE_CONFIG_KEY}`
      : s === "origin-head"
        ? "from origin/HEAD"
        : s === "remote-default"
          ? "the only default-looking branch on origin"
          : "the only default-looking local branch";
}

/**
 * The lines to print when the trunk can't be resolved. Every one of them is a
 * command the reader can run, because the alternative this replaces was a table
 * of confident falsehoods and no way to tell it was lying.
 */
export function baseHelp(result: { reason: string; tried: string | null }): string[] {
  return [
    `✗ Can't tell which branch is this repo's trunk: ${result.reason}.`,
    `  Merge state is measured against it, so without one every branch would read as unmerged.`,
    `  Fix it with any of:`,
    `    retasc <command> --base origin/<trunk>`,
    `    git config --local ${BASE_CONFIG_KEY} origin/<trunk>   (per-repo, remembered)`,
    `    git remote set-head origin -a                 (records origin/HEAD from the remote)`,
  ];
}

/**
 * Is `ref` an ancestor of `base`? THREE outcomes, on purpose:
 * true / false / null for "git couldn't answer".
 *
 * `merge-base --is-ancestor` exits 0 for yes, 1 for no, and 128 for an error
 * (missing ref, unreadable object, a shallow clone that's missing the history).
 * Collapsing 128 into `false` is the RTSC-799 bug in one character, so the
 * unknown is carried out of here as its own value and can never be reaped.
 */
export function mergedInto(run: GitRun, ref: string, base: string): boolean | null {
  const r = run(["merge-base", "--is-ancestor", ref, base]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/**
 * Is the repo a shallow clone, where ancestry answers can't be trusted?
 * `null` when git couldn't say — same rule as `mergedInto`, and for the same reason:
 * this module's whole job is to stop a failed check from reading as a clean answer,
 * and a suppressed warning is exactly the silence RTSC-799 was made of.
 */
export function isShallow(run: GitRun): boolean | null {
  const r = run(["rev-parse", "--is-shallow-repository"]);
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out === "true" ? true : out === "false" ? false : null;
}
