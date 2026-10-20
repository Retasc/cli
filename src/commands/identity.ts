import { api } from "../api.js";
import { clean } from "../lib/text.js";
import { isInteractive } from "./bind.js";
import { selfCommand } from "../lib/launcher.js";
import { VERSION } from "../version.js";
import { identityLoop, type IdentityOutcome } from "./join.js";

// RTSC-477 — `retasc identity`: ask "which of these imported people is you?" on demand,
// instead of only in the one second of `retasc join` where the question happens to come up.
//
// WHY THIS EXISTS, given `join` already asks (RTSC-492). Claiming is per SOURCE, not per
// person: `claimGhost` retires the ghost and points it at the claimant WITHOUT marking the
// human as answered, and `claimableGhosts` hides only the tools they've already linked. The
// backend is therefore built for "claim your ClickUp one now, your Jira one in six months"
// — every migration mints a fresh batch of placeholders and everyone should be asked again.
//
// `join` runs exactly once, at the moment you accept an invite. So for the second migration
// there was no terminal surface at all: a team that onboarded by CLI a year ago had to open
// the Dash or leave the new tool's history on placeholders. That is the recurring gap, and
// it is a bigger one than the onboarding gap this issue was originally filed about.
//
// Three narrower cases fall out for free, all of them people `join` deliberately skipped:
// `--yes`, a non-interactive run, and `--no-bind`.
//
// NOT a --yes command, and there is no `identity claim <name>`. Claiming pulls another
// human's authorship and their dispatch lane onto your account, irreversibly, with no CLI
// path back. `identityLoop` refuses to answer for a scripted run and this must not offer a
// flag that reinstates exactly that. The prompt is the feature.
//
// RTSC-693 UPDATED THIS: an agent CAN now claim, over MCP, but only ever for the human
// its key acts for — `claimGhostCore` takes the claimant as an argument and the MCP door
// supplies `principalUserId`, so there is no argument for WHO claims. See the RTSC-693
// block in convex/ghosts.ts for what that does and does not cover.
//
// This command's own refusal stands unchanged and for its original reason: a CLI run with
// no TTY has nobody to ask, so the prompt IS the feature here.
//
// (Was: "An agent can never get here: every claim path is `requireUser`" — true until the
// MCP door existed, and exactly the kind of comment a future auditor would stop at.)
// This command sits
// behind `requireLogin` (a device-flow human session), so an API key is refused at the door
// with "Not signed in. Run `retasc login` first." rather than a server auth error.

export type IdentityOpts = { orgId?: string };

export type MeOrg = { id: string; name: string; slug?: string | null; role: string };

/**
 * Injected so the endings can be pinned by tests, exactly as `identityLoop`'s are.
 *
 * The outcomes that matter most here are the ones that print NOTHING interesting live: a
 * person who already declined, and a person with nothing waiting. Both are silence in the
 * loop, both must be a sentence in this command, and no org we can run against will produce
 * the first on demand — it is a one-way flag.
 */
export type IdentityCmdDeps = {
  me: () => Promise<{ orgs: MeOrg[] }>;
  loop: (orgId: string, orgLabel: string) => Promise<IdentityOutcome>;
  interactive: () => boolean;
};

/**
 * Which org's placeholders to offer.
 *
 * Same rule as `retasc billing`: explicit `--org-id` wins, one membership needs no
 * question, several must be named. Deliberately NOT the folder binding — that resolves
 * through an agent key, and this is a question only a signed-in human can answer, so
 * reading identity off the folder would name an org this person might not even be in.
 */
export function resolveOrg(orgs: MeOrg[], orgId?: string): MeOrg {
  // Org names are human-typed and land in a terminal that acts on escape sequences, the
  // same rule the ghost rows follow. `clean` here rather than at each interpolation so a
  // later line added to this list cannot forget it.
  const list = () => orgs.map((o) => `  ${o.id}  ${clean(o.name)}${o.slug ? ` (${clean(o.slug)})` : ""}`);
  if (orgId) {
    const found = orgs.find((o) => o.id === orgId);
    // REFUSE an id we can't see, rather than passing it through for the server to reject.
    // The server does not reject it: `memberOf` returns null for a non-member AND for a
    // suspended one, and `claimableGhosts` maps null to `{asked: true}` — the exact shape a
    // permanent decline returns. Passing through would make this command answer "you've
    // already said none of these are you" to someone who simply typed the wrong id, which
    // is a false statement about their own history and the one thing it must never say.
    if (!found) {
      throw new Error(
        `You're not an active member of ${clean(orgId)} — or that isn't an org id.` +
          (orgs.length ? `\nOrgs you can ask about:\n${list().join("\n")}` : ""),
      );
    }
    return found;
  }
  if (orgs.length === 0) throw new Error("You're not a member of any org yet.");
  if (orgs.length > 1) {
    throw new Error(`Several orgs — pass --org-id <id>:\n${list().join("\n")}`);
  }
  return orgs[0];
}

/** What to print once the loop is done. `join` prints nothing; this command must. */
function report(outcome: IdentityOutcome, orgLabel: string): void {
  switch (outcome) {
    case "claimed":
    case "unavailable":
      // Both already said their piece, line by line, as they happened.
      return;
    case "none":
      // The common answer, and a genuinely good one — say it plainly rather than exiting
      // silently, which reads like the command failed to run.
      console.log(`Nothing waiting for you in ${orgLabel}.`);
      console.log("Run this again after a migration — each import brings its own people across.");
      return;
    case "answered":
      // They have answered here before, and nothing is left from a tool they haven't
      // answered about. It differs from "none" only in being able to say what already
      // happened; the advice is identical, because it is now TRUE for both.
      //
      // RTSC-507 rewrote this. It used to read "that answer covers the whole org,
      // including later migrations" and send them to an owner — because one decline really
      // did shut them out of every future import. That sentence existed only to describe a
      // bug, and it goes in the same release the bug does.
      console.log(`You've answered about every tool imported into ${orgLabel} so far.`);
      console.log("Run this again after the next migration — each one is asked about separately.");
      return;
    case "declined":
      console.log("Noted. That covers those tools only, so a later import will ask again.");
      return;
    case "left":
      console.log(`Nothing linked. Run \`${selfCommand(VERSION)} identity\` again whenever you want to look.`);
      return;
    case "skipped":
      // Only reachable non-interactively; the interactive guard below catches that first.
      return;
  }
}

export async function identityAction(
  opts: IdentityOpts,
  deps: Partial<IdentityCmdDeps> = {},
): Promise<IdentityOutcome> {
  const d: IdentityCmdDeps = {
    me: () => api.me() as Promise<{ orgs: MeOrg[] }>,
    // One implementation of the irreversible question, shared with `join`. Two surfaces
    // asking it in two different voices is how someone ends up answering the one they trust
    // less — the same reason its wording already mirrors the Dash notice.
    loop: (orgId, orgLabel) => identityLoop(orgId, {}, orgLabel),
    interactive: isInteractive,
    ...deps,
  };

  // Refuse up front rather than exiting 0 in silence. `identityLoop` returns "skipped"
  // without a TTY — correct inside `join`, where the folder setup is the point and the
  // question is optional, and wrong here, where the question IS the command.
  if (!d.interactive()) {
    throw new Error(
      "`retasc identity` needs an interactive terminal — linking an imported person is irreversible, so it always asks first.",
    );
  }

  const me = await d.me();
  const org = resolveOrg(me.orgs, opts.orgId);
  // The NAME alone, not "name (slug)". It lands mid-sentence in both surfaces — "When Acme
  // migrated…" and "Nothing waiting for you in Acme." The slug only earns its place in the
  // several-orgs error, where it is there to be copied.
  const orgLabel = clean(org.name);

  const outcome = await d.loop(org.id, orgLabel);
  report(outcome, orgLabel);
  return outcome;
}
