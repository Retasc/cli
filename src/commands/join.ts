import { api, cliError, formatError } from "../api.js";
import { loadConfig } from "../config.js";
import { parseInviteCode } from "../lib/invite.js";
import { selfCommand } from "../lib/launcher.js";
import { clean } from "../lib/text.js";
import { VERSION } from "../version.js";
import {
  ask,
  confirm,
  ensureSignedIn,
  isInteractive,
  pickExisting,
  rebindGuard,
  completeWorkspaceSetup,
  type WorkspaceSetupOpts,
} from "./bind.js";

// RTSC-492 — one command, from an invite link to an agent pulling work.
//
// An invited teammate used to face three commands with an ordering trap in them, and no
// browser path at all (RTSC-476). This is the whole of it: sign in, redeem, claim the
// history a migration carried across, pick a project, make `retasc` durable, mint a key,
// bind the folder, wire the MCP marker. The target case is that they never open the Dash.
//
// ORDER, and why it is that order:
//   1. sign in            (only when there is no session)
//   2. redeem the invite
//   3. identity           (claim imported placeholders)
//   4. project
//   5. make `retasc` durable   — decides what the marker says
//   6. mint + bind + wire the marker
//
// Steps 2 and 3 are about the ORG just joined; 4 onward is about this FOLDER. Step 3 has
// to follow step 2 because `claimableGhosts` is member-gated. It must NOT be moved after
// step 4: ghosts are rows in `members`, which carries an `orgId` and no `projectId`, so
// asking after the project pick would imply a link between the two that does not exist.
//
// Every interactive step is conditional on there being a real choice. No session → device
// flow, else skip. Unclaimed placeholders → ask, else silent. More than one project → ask,
// else name it in the bind line. With no imports and one project, the only thing typed is
// the GitHub device code.

export type JoinOpts = WorkspaceSetupOpts & {
  /** Redeem only — today's behaviour, for anything scripted against it. */
  bind?: boolean;
};

/** A ghost whose origin predates `sourceLabel`. Never invent a tool we don't know. */
const UNKNOWN_SOURCE = "another tool";

type Ghost = { id: string; name: string; sourceLabel: string | null };

/**
 * A stop that cannot loop forever.
 *
 * The loop is driven by a server list that shrinks on every claim, so it terminates on its
 * own — but it is a `while (true)` around a network call, and a backend that ever returned
 * an unchanged list would spin a human's terminal rather than fail. Well above any real
 * number of migrated tools.
 */
const MAX_IDENTITY_ROUNDS = 10;

/**
 * The tools on screen, named the way they'd be read aloud (RTSC-507).
 *
 * The twin of `sourcePhrase` in `dash/src/lib/ghostPrompt.ts`, duplicated rather than
 * shared because the two live in separate packages with no common build — the same reason
 * `UNKNOWN_SOURCE` above is a second copy of the Dash's constant. Keep the two in step:
 * they answer the same question in front of the same irreversible decision.
 */
export function sourcePhrase(ghosts: Ghost[]): string {
  const names = [...new Set(ghosts.map((g) => clean(g.sourceLabel ?? UNKNOWN_SOURCE)))].sort((a, b) =>
    // Keep the vague fallback last, so a known tool always leads.
    a === UNKNOWN_SOURCE ? 1 : b === UNKNOWN_SOURCE ? -1 : a.localeCompare(b),
  );
  if (names.length <= 1) return names[0] ?? UNKNOWN_SOURCE;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How one row reads: the person, and the tool they were carried in from. */
function ghostRow(g: Ghost): string {
  // BOTH fields are third-party text: the name was typed by someone in ClickUp/Jira/Asana
  // and carried across verbatim, and `sourceLabel` is the adapter's own record of where.
  // They print into a terminal that acts on escape sequences, right above a prompt.
  return `${clean(g.name)}      from ${clean(g.sourceLabel ?? UNKNOWN_SOURCE)}`;
}

/**
 * What the loop ended up doing, so a caller can say so.
 *
 * `join` ignores this: there, the question is one conditional step inside a setup flow and
 * "nothing was waiting for you" is noise. `retasc identity` (RTSC-477) is the opposite —
 * it was run FOR this, so each outcome needs its own sentence. Without the distinction a
 * standalone run would exit 0 in silence on four different endings, three of which mean
 * "your imported history is still stranded".
 */
export type IdentityOutcome =
  /** Not asked: no TTY, or `--yes`. Never an answer — see the guard below. */
  | "skipped"
  /** This human already said "none of these are me" in this org. Permanent, org-wide. */
  | "answered"
  /** Asked, and there was nothing left to offer. */
  | "none"
  /** At least one placeholder is now linked to them. */
  | "claimed"
  /** They chose "none of these are me (don't ask again)". */
  | "declined"
  /** Rows were offered and they linked none, without declining outright. */
  | "left"
  /** The server couldn't be asked, or refused a claim. Already reported to stderr. */
  | "unavailable";

/** Everything `identityLoop` touches, so a test can stand in for all of it. */
export type IdentityDeps = {
  claimableGhosts: (a: { orgId: string }) => Promise<{ asked: boolean; ghosts: Ghost[] }>;
  claimGhost: (a: { orgId: string; memberId: string }) => Promise<{ name: string }>;
  dismissGhostPrompt: (a: { orgId: string }) => Promise<unknown>;
  askFn: (q: string) => Promise<string>;
  confirmFn: (q: string) => Promise<boolean>;
  interactive: () => boolean;
};

/**
 * "Which of these imported people is you?" — the CLI half of RTSC-433/473.
 *
 * Mirrors the Dash notice (`dash/src/components/GhostClaim.tsx`) deliberately, down to the
 * confirm wording in `dash/src/lib/ghostPrompt.ts`. Two surfaces asking the same
 * irreversible question in two different voices is how someone ends up answering the one
 * they trust less.
 *
 * Never fatal. Everything here is about attribution; the bind that follows is what makes
 * the folder work, and a failure to offer a claim must not cost someone their workspace.
 */
export async function identityLoop(
  orgId: string,
  opts: JoinOpts,
  orgLabel?: string,
  // Injected so the question itself can be pinned by tests. It is asked once per human per
  // org and it is irreversible, so "we ran it live and it looked right" is not evidence —
  // the live orgs available to us have all already answered, which exercises only the
  // silent path. What has to be provable is the loud one.
  deps: Partial<IdentityDeps> = {},
): Promise<IdentityOutcome> {
  const d: IdentityDeps = {
    claimableGhosts: api.claimableGhosts as IdentityDeps["claimableGhosts"],
    claimGhost: api.claimGhost as IdentityDeps["claimGhost"],
    dismissGhostPrompt: api.dismissGhostPrompt,
    askFn: ask,
    confirmFn: confirm,
    interactive: isInteractive,
    ...deps,
  };

  // `--yes` may SKIP this question. It may never answer it: claiming pulls another human's
  // authorship AND their dispatch lane onto your account, irreversibly, and there is no
  // CLI path back. A scripted run has nobody to be wrong on behalf of.
  if (!d.interactive() || opts.yes) return "skipped";

  // Whether anything was linked BEFORE the round that ends the loop. A claim is followed by
  // another round (a second migrated tool may still be offerable), and that round normally
  // ends in "nothing left" — which must not erase the claim that just happened.
  let claimedAny = false;

  for (let round = 0; round < MAX_IDENTITY_ROUNDS; round++) {
    let ghosts: Ghost[];
    try {
      const res = await d.claimableGhosts({ orgId });
      // An empty list is the only ending now (RTSC-507). `asked` no longer gates anything
      // — it used to mean "declined, permanently", and branching on it FIRST is exactly
      // what hid a later migration's placeholders for good. It now only picks the wording:
      // "you've answered everything so far" reads differently from "nothing was ever
      // imported here", and both are empty. `join` treats them alike; `identity` does not.
      if (!res.ghosts.length) {
        if (claimedAny) return "claimed";
        return res.asked ? "answered" : "none";
      }
      ghosts = res.ghosts;
    } catch (e) {
      const { message } = formatError(e);
      console.error(`  ! Couldn't check for imported history (${message}). Carrying on.`);
      return claimedAny ? "claimed" : "unavailable";
    }

    console.log(
      round === 0
        ? `\nWhen ${orgLabel ?? "this org"} migrated, some people were carried across.\n` +
            "One of them may be you:"
        : "\nAnything else here you recognise?",
    );
    // RTSC-507 — the row says what the answer COVERS, because that is what changed.
    // Declining used to write one org-wide flag that shut the person out of every later
    // migration, so the row had to carry the warning "don't ask again". It now records
    // only the tools on screen, so a bare "none of these are me" is finally the literal
    // truth, and naming the tools is what makes the answer safe to give.
    // Compared by REFERENCE below, not by a magic id value: a sentinel that is merely a
    // row with an empty id would let any future ghost with a falsy id read as a decline.
    const NONE: Ghost = {
      id: "",
      name: `None of these are me (covers ${sourcePhrase(ghosts)} only)`,
      sourceLabel: null,
    };
    // No label: the heading above is the prompt, and `choose` would print a second one.
    const chosen = await pickExisting("", [...ghosts, NONE], (g) => (g === NONE ? g.name : ghostRow(g)), d.askFn);

    if (chosen === NONE) {
      try {
        await d.dismissGhostPrompt({ orgId });
      } catch (e) {
        console.error(`  ! ${formatError(e).message}`);
        // NOT "declined". A caller answers that with "noted", and the write is the only
        // thing that makes it true — nothing landed, so these tools WILL be offered again.
        // The error is already on stderr; `unavailable` adds no second sentence on top of
        // it rather than a reassuring false one.
        return "unavailable";
      }
      return "declined";
    }

    // Confirm before claiming — it is irreversible and it moves dispatch routing, so it
    // must not be a single keystroke on a row in a list. Same qualitative wording as the
    // Dash: counting "12 issues, 4 comments" would mean an org-wide scan on exactly the
    // orgs that just ingested a migration.
    const from = clean(chosen.sourceLabel ?? UNKNOWN_SOURCE);
    const question =
      `\n  Link "${clean(chosen.name)}" to your account? Everything they wrote, commented on,\n` +
      `  or were assigned in ${from} becomes yours. This can't be undone.`;
    if (!(await d.confirmFn(question))) {
      // NOT a dismissal. They declined THIS row, which is not the same as "none of these
      // are me" — and dismissing is permanent, so it only ever happens when said outright.
      console.log("  Left unlinked.");
      continue;
    }

    try {
      const res = await d.claimGhost({ orgId, memberId: chosen.id });
      console.log(`✓ Linked ${clean(res.name)}.`);
      claimedAny = true;
    } catch (e) {
      // SOURCE_ALREADY_CLAIMED, IMPORT_RUNNING, NOT_CLAIMABLE — all readable, all reachable
      // by racing the Dash, and none of them a reason to abandon the setup.
      const { code, message, hint } = formatError(e);
      console.error(`  ✗ ${code ? `${code}: ` : ""}${message}`);
      if (hint) console.error(`    → ${hint}`);
      return claimedAny ? "claimed" : "unavailable";
    }
    // Claiming one ClickUp identity removes EVERY remaining ClickUp row (`claimableGhosts`
    // filters by spent source), so the next round can only ever offer a different tool.
  }
  // Round budget spent. Only reachable by declining individual rows over and over — the
  // list is unchanged each time, so nothing was linked and nothing was answered for good.
  return claimedAny ? "claimed" : "left";
}

export async function joinAction(link: string, opts: JoinOpts): Promise<void> {
  // Client-side, before anything else: the code is what the server matches, and someone
  // who pasted the wrong thing should hear it here rather than as "not recognized".
  const code = parseInviteCode(link);

  // An invited teammate joins an org that already exists, so their sign-in parks no ad
  // click: it would never buy an org, and taking it out of the address pool would cost
  // the real signup behind the same router its match (cli/src/lib/adClick.ts).
  await ensureSignedIn(undefined, { invited: true });

  // --- 2. redeem ------------------------------------------------------------
  // Any failure here stops the run. A dead invite means there is no org to bind to, and
  // binding this folder to nothing would be worse than stopping.
  const res = (await api.acceptInvite({ code })) as {
    orgId: string;
    slug: string | null;
    role: string;
    alreadyMember: boolean;
  };
  const orgLabel = res.slug ? clean(res.slug) : undefined;
  const where = orgLabel ? ` "${orgLabel}"` : "";
  if (res.alreadyMember) {
    // Not a failure: the code stays unconsumed by design, so the person it was meant for
    // can still use it. Say so and carry on into the folder half.
    console.log(`• You're already a member of org${where} (${res.role}).`);
  } else {
    console.log(`✓ Joined org${where} as a ${res.role}.`);
  }

  if (opts.bind === false) {
    // `--no-bind` is redeem-only, exactly as `join` behaved before RTSC-492 — including
    // asking nothing, so anything scripted against it sees the same output and the same
    // exit code. The identity prompt still reaches them through the Dash.
    return;
  }

  // --- 3. identity ----------------------------------------------------------
  // BEFORE anything about this folder, including the re-bind guard. Ghosts are rows in
  // `members`, which carries an `orgId` and no `projectId`: the question belongs to the org
  // just joined, and this is the only time `join` asks it. Gating it behind the folder half
  // would mean someone whose folder is already bound elsewhere — who declines the re-bind —
  // silently never sees it, and their imported history stays stranded.
  await identityLoop(res.orgId, opts, orgLabel);

  // --- the folder half ------------------------------------------------------
  const cfg = loadConfig();
  const self = selfCommand(VERSION);
  const resume = `${self} bind --org-id ${res.orgId}`;

  const guard = await rebindGuard({
    cwd: process.cwd(),
    mcpUrl: cfg.mcpUrl,
    orgId: res.orgId,
    projectId: opts.projectId,
    yes: opts.yes,
  });
  if (!guard.proceed) {
    // The membership landed either way — never let a declined or no-op re-bind read as a
    // failed join. `rebindGuard` has already said what it did with the folder, INCLUDING
    // setting a non-zero exit code for the non-interactive refusal, so don't paper over
    // that with a line that reads like everything is finished.
    if (process.exitCode) console.error(`  You did join org${where}; only the folder was left alone.`);
    else console.log(`  You're a member of org${where}. Nothing else to do here.`);
    return;
  }

  try {
    await completeWorkspaceSetup({
      orgId: res.orgId,
      orgLabel,
      opts,
      existing: guard.existing,
      // `createProject` is `requireOwnerOrAdmin`, and an invite only ever grants `member`
      // (admin is granted by `setMemberRole` after joining, never by a bearer code —
      // RTSC-561). Offering "+ create new" here would be offering a refusal as a choice.
      canCreateProject: false,
    });
  } catch (e) {
    // Say what SUCCEEDED before reporting the failure, and name the command that resumes.
    // The membership (and any identity claim) already landed and cannot be re-done: the
    // invite is consumed now, so re-running `join` with the same link would report
    // "already used" and read like the whole thing failed.
    console.error(`\n  You did join org${where} — only this folder's setup didn't finish.`);
    console.error(`  Resume with:  ${resume}`);
    throw e;
  }
  // RTSC-519 — the closing line moved into `completeWorkspaceSetup`, the tail both commands
  // already share, so `bind` gets it too. Saying it here as well would say it twice.
}
