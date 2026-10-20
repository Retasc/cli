/**
 * What `bind` reports when an AGENT is driving it (RTSC-713).
 *
 * # Why this exists
 *
 * An agent decides whether to keep going from three signals, and all three are
 * structural rather than semantic: the exit code, which stream the output came on, and
 * whether the text reads like a fault. Before this module, "signed in, session written,
 * nothing named yet" fired all three:
 *
 *     ✗ UNAUTHENTICATED: Not signed in. Run `npx -y @retasc/cli@1.30.0 login` first
 *       (no TTY here for the device flow).
 *
 * An agent that stops there is reading the signals correctly. The signals were wrong.
 * Sign-in had succeeded, the session was on disk, and the only thing left was a question
 * it could have asked its human in one sentence.
 *
 * So the rule this module enforces: **the exit code and the framing encode "can I
 * continue?", not "did something unexpected happen?"** A state the flow can be resumed
 * from exits 0 on stdout and never says error, however incomplete it is. Only a genuine
 * dead end — nothing the agent or its human can do from here — exits non-zero.
 *
 * # Why not just word the instruction better
 *
 * Telling the agent "if you see UNAUTHENTICATED it is fine, keep going" asks a model to
 * override the strongest stop signal it has on the strength of a sentence it read
 * earlier. Sometimes it will and sometimes it will not, and which one is not something
 * this codebase controls. Exiting 0 is deterministic. This is the same reasoning that
 * put the claim nudge and the setup instructions in the server response rather than in
 * CLAUDE.md: a mechanism beats advice.
 *
 * # Why the states live HERE and not in the server's instruction string
 *
 * The obvious alternative was a lookup table in `convex/lib/setupInstructions.ts`: "if
 * the CLI says X do this, if it says Y do that." That is a second copy of this list,
 * living in a different language, in a different deploy cycle, maintained by whoever
 * touches it next. They diverge, and the divergence is invisible until an agent acts on
 * a state that no longer exists.
 *
 * This repo has already paid for that once. `setupInstructions.ts` opens by explaining
 * it was lifted out of `http.ts` "because it now has TWO readers and they must never
 * diverge", and RTSC-694 was an entire issue spent collapsing one setup command into one
 * place. So: the CLI owns its states and each one carries its own next step, and the
 * server instruction says only "run this, act on what it tells you." Adding a state
 * costs one change, in this file, and no server string can go stale.
 *
 * There is a test that greps for these code strings under `convex/`. If one ever appears
 * there, the split has been broken.
 */

import { homedir } from "node:os";

/**
 * Every terminal outcome of an agent-driven `bind`, in two classes.
 *
 * CONTINUABLE — the flow is alive and wants something. Exit 0, stdout, no fault
 * vocabulary. The agent reads it, asks its human the one question that applies, and runs
 * the next pass.
 *
 * TERMINAL — nothing the agent or its human can do inside this flow. Exit non-zero and
 * say so plainly, because stopping is genuinely the right move.
 *
 * Note where NEEDS_SIGN_IN sits. Reaching a command with no session, having not yet
 * tried to get one, is CONTINUABLE: the answer is to sign in, not to give up. Only a
 * sign-in that was attempted and failed is terminal. Collapsing those two was the
 * original bug.
 */
export const CONTINUABLE_STATES = [
  /** No session, and no attempt has been made yet. The browser door is available. */
  "NEEDS_SIGN_IN",
  /**
   * RTSC-879 — a device grant HAS been started and is waiting on the human's click.
   *
   * Continuable, and the distinction from `NEEDS_SIGN_IN` is the whole point: there,
   * nothing has happened and the agent should begin. Here a code is live, the human has
   * been handed it, and re-starting would issue a second code that invalidates the one
   * they are looking at. The agent's move is to run the same command again, unchanged.
   */
  "SIGN_IN_PENDING",
  /** Signed in. Zero orgs, or more than one, so which org this folder is for is unknown. */
  "NEEDS_ORG",
  /** Org settled. Zero projects, or more than one, so which project is unknown. */
  "NEEDS_PROJECT",
  /**
   * Signed in, and holding an invitation. The choice is join-or-create and it is the
   * human's to make.
   *
   * NOT called PENDING_INVITE, deliberately: `convex/setupStatus.ts` already has a state
   * by that name and it means something else — a membership offer the server is
   * surfacing, rather than the reason `bind` stopped. Two different things sharing one
   * identifier across the boundary is precisely the confusion this file's split exists to
   * prevent, so this one is named for the decision it is asking for.
   */
  "NEEDS_JOIN_OR_CREATE",
  /** Everything named and written. The folder is bound; the client must restart. */
  "BOUND",
] as const;

export const TERMINAL_STATES = [
  /** Sign-in was attempted and did not complete: declined, timed out, or rejected. */
  "SIGN_IN_FAILED",
  /** No door exists: no browser reachable and no TTY. SSH and CI land here. */
  "NO_SIGN_IN_DOOR",
  /** This folder is already bound and the run was refused rather than silently re-pointed. */
  "ALREADY_BOUND",
  /** The credential was refused: revoked key, suspended member, deleted workspace. */
  "REFUSED",
] as const;

export type ContinuableState = (typeof CONTINUABLE_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type OutcomeState = ContinuableState | TerminalState;

export function isContinuable(state: OutcomeState): boolean {
  return (CONTINUABLE_STATES as readonly string[]).includes(state);
}

/** `name` is optional because not every state knows it: a run that bound via `--org-id`
 *  holds the id and never listed the org. Better absent than invented. */
/**
 * A question for the human, as data (RTSC-720) — the same shape the MCP surface speaks
 * in `convex/lib/askHuman.ts`, mirrored here because the two packages cannot import each
 * other and MUST NOT drift. A test reads both files and fails if the field vocabulary
 * diverges; if you add a field here, add it there, and vice versa.
 *
 * Why the CLI needs it at all: RTSC-717 took the questions out of prose on the MCP
 * surface, and the CLI — the surface that asks the FIRST questions a new user ever
 * sees — kept a `next` sentence. On a real fresh-machine run the agent, handed
 * NEEDS_ORG as prose, authored the three questions itself in a paragraph; and after a
 * restart the same sentence read as a STATUS, so the agent reported "you are logged in
 * but have no organization" and waited, until the human asked whether it was supposed
 * to be asking something. A sentence describing a state is something to relay; a
 * question with fields is something to ask.
 *
 * `input: "text"` is the kind the MCP side did not need until now: "what should your
 * workspace be called?" is not pick-one. Elicitation renders it as a plain string field
 * (no enum), so both renderings still work.
 */
export type AskOption = { value: string; label: string; detail?: string };
export type AskQuestion = {
  /** Stable id for the decision, e.g. `org.name`. */
  id: string;
  question: string;
  /** Context the human needs to answer. Optional. */
  context?: string;
  /** Pick-one questions carry options; free-text questions carry `input: "text"`. */
  options?: AskOption[];
  input?: "text";
  /** e.g. "ACME" for a prefix. Only meaningful with input: "text". */
  hint?: string;
  /** How to come back: the tool/command to run again, and the flag the answer fills. */
  resume: { tool: string; arg?: string };
};

/**
 * The questions each continuable state asks, as pure builders so they are testable
 * without a network. bindAction attaches their output to the outcome it emits.
 */
/**
 * Names suggested from the folder, or null when the folder does not name anything
 * (RTSC-722).
 *
 * Every question in the setup matrix needs OPTIONS, because a picker cannot render a
 * question that has none — which is exactly why RTSC-720's three free-text questions
 * came out as prose. The folder is where the defaults come from: somebody working in
 * `~/the egg` almost certainly wants a workspace called The Egg, and the common case
 * becomes a click rather than three typed answers.
 *
 * NULL for a folder that names nothing, and this guard is load-bearing rather than
 * tidy. The run before this one had a human standing in `/Users` — suggesting "Users"
 * as their workspace name would have made a WRONG binding easier to accept, which is
 * the opposite of what the folder confirmation exists for. Home, root, a dotfile and
 * the usual meaningless container directories all decline to suggest, and those
 * questions fall back to text.
 */
const UNHELPFUL = new Set([
  "users", "home", "root", "src", "lib", "tmp", "temp", "var", "opt", "etc", "desktop",
  "documents", "downloads", "projects", "project", "code", "dev", "developer", "repos",
  "repo", "workspace", "work", "apps", "app", "api", "web", "www", "site", "server",
  "client", "backend", "frontend", "main", "new", "new folder", "untitled folder", "untitled",
  "node modules", "git", "github", "test", "tests", "build", "dist",
]);

/** Longest suggestion worth offering. The server caps an org name at 120 (manage.ts
 *  MAX_ORG_NAME), but a picker option is read at a glance and a folder whose basename
 *  runs past this is not a workspace name anyway. */
const MAX_SUGGESTED_NAME = 48;

/** Case-folded, trailing-separator-free, for comparing two paths for sameness. */
const samePath = (a: string, b: string) =>
  a.replace(/[/\\]+$/, "").toLowerCase() === b.replace(/[/\\]+$/, "").toLowerCase();

export function suggestNames(folder: string, home = homedir()): { name: string; prefix: string } | null {
  const trimmed = folder.replace(/[/\\]+$/, "");
  // The home directory names the HUMAN, not the work. It is the likeliest wrong folder
  // after `/Users` itself, and "Kim" as a workspace name is plausible enough to click
  // past — which is exactly the wrong-folder binding the confirm exists to catch. The
  // basename check below cannot see this: "kim" is not a generic container word.
  // Case-insensitively, because macOS and Windows filesystems are: `/users/kim` and
  // `/Users/kim` are the same directory and only one of them would match an exact compare.
  if (home && samePath(trimmed, home)) return null;

  const raw0 = trimmed.split(/[/\\]/).pop() ?? "";

  // Fold accents to their ASCII base BEFORE splitting. The split treats every character
  // outside [A-Za-z0-9] as a SEPARATOR, so without this `café-api` silently becomes
  // "Caf Api" and `résumé` becomes "R Sum" — a confident, wrong, pre-filled default,
  // which is the one thing this function's null-return exists to avoid. A basename that
  // is entirely non-Latin already returns null (no words survive); it is the MIXED case
  // that mangles.
  const base = raw0.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  // Anything still outside ASCII after folding (CJK, Cyrillic, emoji) cannot be
  // transliterated honestly, so decline rather than drop characters.
  if (/[^\x20-\x7E]/.test(base)) return null;

  // A dotfile directory, an empty basename (root), or a generic container names nothing
  // about the work. `-2`/` 2` suffixes are stripped first, so "New Folder 2" and
  // "project-3" decline the same way their unsuffixed forms do.
  const generic = base.toLowerCase().replace(/[\s._-]+\d+$/, "").replace(/[_-]+/g, " ").trim();
  if (!base || base.startsWith(".") || UNHELPFUL.has(generic)) return null;

  const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  // Do not offer a default the server will reject, or one a picker cannot show.
  if (name.length > MAX_SUGGESTED_NAME) return null;

  // Must satisfy the server's own rule — /^[A-Z][A-Z0-9]{1,9}$/ (manage.ts). A suggested
  // default the server then rejects is worse than no suggestion, because the human
  // accepted it and the failure arrives afterwards, attributed to nothing they did.
  const joined = words.join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
  // A mid-word truncation reads as a typo, and the prefix then appears in EVERY issue id
  // in the project (renaming one is owner-gated and Dash-only). `a-very-long-project-name`
  // as AVERYLONGP is worse than no suggestion; its initials, AVLPN, is a real prefix.
  const prefix =
    joined.length <= 10
      ? joined
      : words.map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) return null;
  return { name, prefix };
}

/**
 * The escape every suggested question carries, so the matrix never traps anyone.
 *
 * The value is a SENTINEL, not a word. `toElicitation` turns the option list into a JSON
 * schema `enum`, and the instructions tell the agent to put the chosen value in the named
 * flag — so a human-readable escape value like "other" arrives as `--org-name other` and
 * names the workspace "other". `bind` rejects this exact string on every answer flag
 * (`answeredElsewhere` below), so a mistake costs one more question rather than a wrongly
 * named workspace. Enforced in the command, not in the wording: an instruction the agent
 * can misread is not a guard.
 */
export const ELSEWHERE_VALUE = "__ask_me__";
/** A picker renders at most four options (AskUserQuestion caps there, and a longer list
 *  stops being scannable anyway). Emitting more is the RTSC-722 defect. */
export const MAX_OPTIONS = 4;

const ELSEWHERE = { value: ELSEWHERE_VALUE, label: "Something else — I'll tell you" };

/**
 * Which answers came back as the escape, so the re-ask does NOT re-offer the suggestion
 * the human just declined. Without this the same matrix comes back unchanged and the
 * exchange loops: suggestion, "something else", same suggestion.
 */
export function answeredElsewhere(opts: {
  orgName?: string;
  project?: string;
  prefix?: string;
}): Set<string> {
  const out = new Set<string>();
  if (opts.orgName === ELSEWHERE_VALUE) out.add("org.name");
  if (opts.project === ELSEWHERE_VALUE) out.add("project.name");
  if (opts.prefix === ELSEWHERE_VALUE) out.add("project.prefix");
  return out;
}

export function orgQuestions(
  signedInAs: string | undefined,
  folder: string,
  declined: Set<string> = new Set(),
  answered: Set<string> = new Set(),
): AskQuestion[] {
  const context =
    (signedInAs ? `Signed in as ${signedInAs}. ` : "") +
    `These three answers create the workspace; the folder question is what connects ` +
    `THIS folder to it.`;
  const g = suggestNames(folder);
  // With a usable folder name every question carries options, so all four render as ONE
  // matrix and the common case is four clicks on pre-filled defaults. Without one they
  // stay text — a wrong suggestion is worse than a typed answer.
  // `hint` is documented on BOTH sides of the mirror (here and convex/lib/askHuman.ts) as
  // meaningful only with `input: "text"`, so it rides the text branch only. A question
  // showing THEEGG does not also need "e.g. ACME".
  const suggested = (value: string, arg: string, id: string, question: string, hint?: string): AskQuestion =>
    g && !declined.has(id)
      ? { id, question, options: [{ value, label: value }, ELSEWHERE], resume: { tool: "bind", arg } }
      : { id, question, input: "text", ...(hint ? { hint } : {}), resume: { tool: "bind", arg } };
  // An answer already in hand is not a question. Declining ONE of the three used to
  // re-emit all three, so a human who had already named their project was asked for it a
  // second time, and could answer differently the second time.
  const all: AskQuestion[] = [
    { ...suggested(g?.name ?? "", "--org-name", "org.name", "What should your workspace (organization) be called?"), context },
    suggested(g?.name ?? "", "--project", "project.name", "And the first project?"),
    suggested(g?.prefix ?? "", "--prefix", "project.prefix", "A short prefix for issue ids?", "e.g. ACME"),
    {
      // The folder rides IN the exchange, not after it. It earned this on the run that
      // shaped RTSC-720: the human was standing in /Users, the outcome named the path,
      // and the agent caught it before anything was written. A wrong binding has no
      // symptom once written (RTSC-532).
      id: "bind.folder",
      question: `Connect ${folder} to that project?`,
      options: [
        { value: "yes", label: `Yes — ${folder} is the right folder` },
        { value: "no", label: "No — I am in the wrong folder", detail: "Open the right one and run setup there instead." },
      ],
      resume: { tool: "bind" },
    },
  ];
  return all.filter((q) => !answered.has(q.id));
}

export function projectQuestions(
  folder: string,
  projects: Array<{ id: string; prefix?: string; name?: string }>,
  declined: Set<string> = new Set(),
): AskQuestion[] {
  if (projects.length) {
    // RTSC-722 again, on the path the first pass missed. A picker renders at most FOUR
    // options, so an org with five projects reproduced the exact failure this issue is
    // about: unrenderable, so the question degrades to prose. Show three and an escape;
    // the outcome carries the FULL list in `projects`, so "none of these" means the agent
    // reads that list out and passes the id the human picks — an escape, not a dead end.
    const shown = projects.length <= MAX_OPTIONS ? projects : projects.slice(0, MAX_OPTIONS - 1);
    const options = shown.map((p) => ({
      value: p.id,
      label: `${p.prefix ?? ""} — ${p.name ?? p.id}`.trim(),
    }));
    if (shown.length < projects.length) {
      options.push({
        value: ELSEWHERE_VALUE,
        label: `None of these — show me all ${projects.length}`,
      });
    }
    return [
      {
        id: "project.pick",
        question: `Which project is ${folder} for?`,
        options,
        resume: { tool: "bind", arg: "--project-id" },
      },
    ];
  }
  // Same rule as orgQuestions: options where the folder names something, text where it
  // does not. This path is reached with an org already chosen and no projects in it.
  const g = suggestNames(folder);
  const pick = (id: string) => g && !declined.has(id);
  return [
    pick("project.name")
      ? { id: "project.name", question: "What is the first project called?", options: [{ value: g!.name, label: g!.name }, ELSEWHERE], resume: { tool: "bind", arg: "--project" } }
      : { id: "project.name", question: "What is the first project called?", input: "text", resume: { tool: "bind", arg: "--project" } },
    pick("project.prefix")
      ? { id: "project.prefix", question: "A short prefix for issue ids?", options: [{ value: g!.prefix, label: g!.prefix }, ELSEWHERE], resume: { tool: "bind", arg: "--prefix" } }
      : { id: "project.prefix", question: "A short prefix for issue ids?", input: "text", hint: "e.g. ACME", resume: { tool: "bind", arg: "--prefix" } },
  ];
}

export type OrgRef = { id: string; name?: string; slug?: string };
export type ProjectRef = { id: string; prefix?: string; name?: string };

export type Outcome = {
  state: OutcomeState;
  /** Precomputed so a reader never has to know the two lists above. */
  continuable: boolean;
  /**
   * The ABSOLUTE path this run binds, or would bind.
   *
   * Always present, on every state including the failures, because it is the one fact
   * the human has to confirm and the agent cannot infer. A binding written against the
   * wrong folder has no symptom: the agent still calls in, the Dash still shows a
   * healthy workspace, and the folder they actually work in has no Retasc tools. RTSC-532
   * put the path in the success line for this reason; an agent-driven run needs it
   * BEFORE the write, which means on the continuable states too.
   */
  folder: string;
  signedInAs?: string;
  /** Present on NEEDS_ORG so the agent can ask with the real list rather than guessing. */
  orgs?: OrgRef[];
  /** Present on NEEDS_PROJECT, scoped to the org already settled. */
  projects?: ProjectRef[];
  pendingInvites?: Array<{ org: string; orgSlug?: string }>;
  org?: OrgRef;
  project?: ProjectRef;
  /** Which flags would carry this forward, e.g. ["--org-name", "--project", "--prefix"]. */
  missing?: string[];
  /**
   * The questions to ask, ready to render (RTSC-720). When present, the agent presents
   * THESE — verbatim labels, no invented options — instead of authoring its own from
   * `next`. `next` stays for any reader that ignores structure.
   */
  askHuman?: AskQuestion[];
  /** A ready-to-relay sentence for the human, the tellHuman convention (RTSC-717). */
  tellHuman?: string;
  /**
   * What to do next, in one sentence, addressed to the agent.
   *
   * Every state carries one. This is the half that makes the server's instruction able
   * to stay generic: it can say "act on what it tells you" precisely because there is
   * always something here to act on.
   */
  next: string;
};

/**
 * One JSON object per line on stdout, so a reader tailing a backgrounded run sees each
 * event as it happens rather than only at exit.
 *
 * NDJSON rather than one object at the end, and the reason is the whole flow: the
 * approve URL has to reach the agent WHILE the process is still blocked waiting for the
 * click. A single trailing payload would arrive five minutes late, after the thing it
 * was meant to prompt. `startBrowserLogin` was already split in two so the URL is
 * available before the wait; this is the other half of that.
 */
export type Event =
  /** RTSC-879 — `code` is present for a DEVICE grant and absent for the browser door.
   *  Optional rather than a second event name so a client already watching
   *  `approve_url` keeps working and simply gains a field: the URL is the thing to
   *  open in both cases, and the code is what the provider's page then asks for. */
  | { event: "approve_url"; url: string; code?: string }
  | { event: "outcome"; outcome: Outcome };

/** stdout, one line, no trailing prose. Never stderr: see the module header. */
export function emit(e: Event): void {
  process.stdout.write(JSON.stringify(e) + "\n");
}
