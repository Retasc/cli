import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Which repository is this directory part of? (RTSC-862.)
 *
 * The answer is git's COMMON DIR — the one directory every worktree of a repository
 * shares. It is the only thing that makes "the same repo" a decidable question:
 *
 *   • normal clone `~/retasc`            → `~/retasc/.git`
 *   • its worktree `~/retasc-rtsc-862`   → `~/retasc/.git`      (same repo)
 *   • bare layout `~/retasc/.bare` with
 *     worktrees `main`, `rtsc-854`       → `~/retasc/.bare`     (same repo)
 *   • an unrelated clone nested inside   → its own `.git`       (different repo)
 *
 * WHY NOT SHELL OUT. `git rev-parse --git-common-dir` answers this directly, and this
 * function deliberately does not call it. It runs at the start of every proxy session,
 * which is every MCP server startup in every harness, and spawning a process there
 * buys a fork+exec on a path whose whole job is to resolve a key in milliseconds. The
 * on-disk format this reads is stable and documented (gitrepository-layout).
 *
 * TRUST MODEL, since this decides which ORG a folder acts in — so a `.git` file is now a
 * routing input, not merely a stop marker, and it is content that can arrive in an
 * archive. git refuses to track a path named `.git`, so this cannot come from a clone,
 * but a tarball, a vendored bundle or a scaffold generator can carry one.
 *
 * So a worktree pointer is only believed when it is RECIPROCAL, the way git's own
 * worktree bookkeeping is: `<common>/worktrees/<name>/gitdir` must point back at the
 * `.git` file we started from. A hand-written `gitdir:` line at someone else's repository
 * fails that check and resolves to nothing, where before this it would have claimed that
 * repository's binding. Verified both ways.
 *
 * The check is git's own invariant rather than an invention, so it costs nothing on a
 * real worktree and cannot drift from what git considers linked. What is deliberately NOT
 * attempted is out-guessing git in general: if someone can write `.git` into a directory
 * you work in, they already own your hooks and config there, which is a larger problem
 * than a binding. The narrow thing we owe is never to resolve ACROSS repositories git
 * considers distinct — which is also why submodules, whose gitdirs carry no `commondir`,
 * resolve to themselves.
 *
 * NEVER THROWS. A malformed `.git` file, a dangling gitdir, a permissions error: all
 * return undefined. Resolution failing means "no binding found", which the caller
 * already handles; a startup crash in the proxy takes the agent's tools away entirely,
 * which is far worse than a folder that needs `retasc bind` run again.
 */
export function gitCommonDir(dir: string): string | undefined {
  try {
    const dotGit = join(dir, ".git");
    if (!existsSync(dotGit)) return undefined;

    // A normal clone: `.git` is a directory and IS the common dir. A worktree's private
    // gitdir is also a directory and looks identical from here, which is what the
    // `commondir` probe below distinguishes — git writes that file only in the private
    // one. `GIT_DIR` pointed at a worktree gitdir lands here too.
    if (statSync(dotGit).isDirectory()) return followCommonDir(dotGit);

    // A worktree: `.git` is a FILE holding `gitdir: <path to the private gitdir>`.
    // FIRST line only, as real git reads it — an `m` flag here would accept the pointer
    // anywhere in the file, widening what an archive can smuggle in.
    const first = readFileSync(dotGit, "utf8").split(/\r?\n/, 1)[0];
    const m = /^gitdir:\s*(.+?)\s*$/.exec(first);
    if (!m) return undefined;
    const gitdir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
    if (!existsSync(gitdir)) return undefined; // dangling: the worktree was pruned
    if (!pointsBackAt(gitdir, dotGit)) return undefined;
    return followCommonDir(gitdir);
  } catch {
    return undefined;
  }
}

/**
 * Does this private gitdir agree that it belongs to this worktree?
 *
 * git keeps the link in both directions: the worktree's `.git` file names the private
 * gitdir, and `<gitdir>/gitdir` names the worktree's `.git` file back. Only the first
 * direction is writable by whoever plants a folder, so checking the second is what turns
 * "a file claims to belong to your repo" into "your repo agrees".
 *
 * A gitdir with no `gitdir` file is not a worktree's — a submodule's private dir, or the
 * bare/main directory reached some other way — so this returns false and the caller
 * resolves nothing, which is the safe direction.
 */
function pointsBackAt(gitdir: string, dotGitFile: string): boolean {
  try {
    const back = join(gitdir, "gitdir");
    if (!existsSync(back)) return false;
    const claimed = readFileSync(back, "utf8").trim();
    if (!claimed) return false;
    return realish(claimed) === realish(dotGitFile);
  } catch {
    return false;
  }
}

/**
 * Resolve a gitdir to the repository's common dir.
 *
 * A worktree's private gitdir carries a `commondir` file (usually `../..`) pointing at
 * the shared one. A main `.git` has no such file and is already the common dir. Reading
 * the file rather than assuming `../..` is what makes the bare layout work, where the
 * shared directory is `.bare` rather than `.git`.
 */
function followCommonDir(gitdir: string): string | undefined {
  const marker = join(gitdir, "commondir");
  if (!existsSync(marker)) return realish(gitdir);
  const rel = readFileSync(marker, "utf8").trim();
  if (!rel) return realish(gitdir);
  return realish(isAbsolute(rel) ? rel : resolve(gitdir, rel));
}

/**
 * Resolve a path the same way `gitCommonDir` resolves the ones it returns.
 *
 * Exported because comparing an unresolved path against a resolved one is a silent
 * mismatch on macOS, where `/var` is a symlink to `/private/var` and a temp dir spells
 * itself both ways. Anything compared against this module's output comes through here.
 */
export function realPath(p: string): string {
  return realish(p);
}

/**
 * Resolve for comparison. `realpathSync` matters on macOS, where `/tmp` is a symlink to
 * `/private/tmp` and two spellings of one directory would otherwise never match — the
 * same reason `findBindingByPath` resolves both sides before comparing.
 */
function realish(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    // A path that does not exist cannot be realpath'd. Comparing the lexical form is
    // still better than giving up, and the callers only ever compare two of these.
    return resolve(p);
  }
}
