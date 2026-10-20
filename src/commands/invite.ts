import { cliError } from "../api.js";
import { pickExisting, isInteractive, ask } from "./bind.js";
import { clean } from "../lib/text.js";

// RTSC-667 — `members invite` asks, instead of demanding two Convex ids.
//
// It used to REQUIRE `--org-id`, and RTSC-664 added `--project-id` on top. Neither is
// discoverable: `whoami` prints org ids, but NOTHING in the CLI lists project ids, so
// the scoped-invite flag shipped in a form a human could not practically use.
//
// It was also the odd one out. `bind` and `join` — the commands a human is most likely
// to run — already ask, through the same `pickExisting` used here. This makes the
// invite path agree with them rather than inventing a third convention.
//
// The flags still work and still win. What changes is only what happens when they are
// ABSENT: a terminal gets a question, a script gets what it always got.
//
// Both functions take their list rather than fetching it, so the decision — which is
// the part with rules in it — is testable without a network or a stubbed module. The
// command does the fetching, and only when the answer isn't already on the command
// line: naming `--org-id` must not cost a round trip to ask a question nobody sees.

export type InviteOrg = { id: string; name: string; slug?: string; role?: string; deleting?: boolean };
export type InviteProject = { id: string; name: string; prefix: string };

type Opts = { interactive?: boolean; askFn?: (q: string) => Promise<string> };

/**
 * Parse an answer to the multi-select prompt into 1-based positions (RTSC-669).
 *
 * Exported for its tests: this is the whole of the input rule, and the rule is the part
 * that goes wrong. Returns null for anything that isn't a clean selection, so every
 * rejection re-prompts rather than resolving to a subset of what was typed — picking
 * SOME of the projects somebody listed is worse than picking none, because they would
 * never see which ones went missing.
 *
 * `max` is the highest offerable position.
 */
export function parseSelection(answer: string, max: number): number[] | null {
  const tokens = answer.split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return null;
  const out: number[] = [];
  for (const t of tokens) {
    // Digits ONLY. `Number()` alone accepts "0x4", "4e0", "+4" and "4.0", and RTSC-269
    // is the record of what happens when a non-canonical spelling reaches a branch it
    // was never meant to: a typo picked the destructive option instead of re-asking.
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    if (n < 1 || n > max) return null;
    if (!out.includes(n)) out.push(n); // "2,2" is a typo, not a double selection
  }
  return out;
}

/**
 * Which org is this invite for?
 *
 * Only orgs the caller can actually invite into are offered. The owner/admin gate is
 * enforced server-side (`requireOwnerOrAdmin`), and offering a plain member an org they
 * will be refused reads as permission — the same rule `pickExisting`'s own header
 * states. Orgs mid-delete are dropped for the same reason: `acceptInvite` refuses them.
 */
export async function chooseInviteOrg(orgs: InviteOrg[], opts: Opts = {}): Promise<string> {
  const eligible = orgs.filter((o) => !o.deleting && o.role !== "member");

  if (eligible.length === 0) {
    cliError(
      "FORBIDDEN",
      "You can't invite anyone: you're not an owner or admin of any org.",
      "Ask an owner of the org you want to invite into to send the invite, or to make you an admin.",
    );
  }
  // One choice is not a choice. The confirmation line names the org afterwards, so
  // nothing is silently assumed on the caller's behalf.
  if (eligible.length === 1) return eligible[0].id;

  const interactive = opts.interactive ?? isInteractive();
  if (!interactive) {
    cliError(
      "AMBIGUOUS",
      `You're an owner or admin of ${eligible.length} orgs, so one has to be named.`,
      `Pass --org-id <id>: ${eligible.map((o) => `${clean(o.name)}=${o.id}`).join(", ")}`,
    );
  }
  const chosen = await pickExisting(
    "Which org",
    eligible,
    (o) => (o.slug ? `${clean(o.name)} (${clean(o.slug)})` : clean(o.name)),
    opts.askFn ?? ask,
  );
  return chosen.id;
}

/**
 * Which projects may the invitee reach? `undefined` ⇒ every project.
 *
 * MULTI-select (RTSC-669), because the data model always was: `projectIds` is an array
 * and the Dash modal has picked any combination since RTSC-665. Shipping a single-select
 * picker here left "two of these four" expressible nowhere — the documented workaround,
 * repeating `--project-id`, needs ids that nothing in the CLI lists, which is the very
 * gap the picker was added to close.
 *
 * Hand-rolled rather than widened out of `choose`/`pickExisting`: those are single-select
 * by contract and `bind`, `join` and the identity prompt all rely on it. Teaching them to
 * return "one or many" would put that ambiguity into every picker in the product to serve
 * one caller.
 *
 * The menu's FIRST entry is "All projects" — an explicit option, never the thing you
 * get by not answering, and never combinable with the others (that is a contradiction
 * about the widest grant there is, so it re-prompts rather than resolving). Handing
 * someone the whole org should be a choice somebody made; that is the same call the
 * Dash's invite form makes, for the same reason.
 *
 * Two cases skip the question and mean "every project", which is what this command has
 * always done when no project was named:
 *   • fewer than two projects — there is nothing to choose between
 *   • no TTY — a script that named no project keeps its behaviour, and prompting a
 *     pipeline is how a release hangs CI rather than failing it
 */
export async function chooseInviteProjects(
  projects: InviteProject[],
  opts: Opts = {},
): Promise<string[] | undefined> {
  if (projects.length < 2) return undefined;
  const interactive = opts.interactive ?? isInteractive();
  if (!interactive) return undefined;

  const askFn = opts.askFn ?? ask;
  console.log("\nWhich projects can they see:");
  console.log("  1) All projects");
  projects.forEach((p, i) => console.log(`  ${i + 2}) ${clean(p.name)}`));
  const max = projects.length + 1;

  // Three attempts then abort, the cap `choose` uses: an EOF stdin returns "" forever,
  // and a prompt that re-asks forever is a hang rather than a failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    const picked = parseSelection(await askFn("Choose a number, or several (e.g. 2,4): "), max);
    if (!picked) {
      console.log(`Please enter numbers between 1 and ${max}, separated by commas.`);
      continue;
    }
    const wantsAll = picked.includes(1);
    if (wantsAll && picked.length > 1) {
      // Not resolvable either way, so it must not be resolved. "All projects AND
      // Marketing" is a contradiction about the widest grant in the product, and
      // guessing which half they meant is how someone hands over an org by accident.
      console.log("1) All projects can't be combined with individual projects. Pick one or the other.");
      continue;
    }
    if (wantsAll) return undefined;
    const chosen = picked.map((n) => projects[n - 2]);
    // Naming every project IS "all projects", and storing it as a list would freeze the
    // grant at today's set — a project added next month would be missing from a scope
    // its author chose as everything. `normalizeInviteScope` collapses this server-side
    // too; doing it here as well keeps the confirmation honest about what was granted.
    return chosen.length === projects.length ? undefined : chosen.map((p) => p.id);
  }
  throw new Error("no valid choice — aborting");
}
