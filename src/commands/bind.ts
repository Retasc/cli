import { basename } from "node:path";
import { api, cliError } from "../api.js";
import { deviceLogin, deviceStart, deviceFinish, type PendingDevice } from "../auth.js";
import { SITE_URL } from "../lib/adClick.js";
import { loadConfig, patchConfig } from "../config.js";
import { installMarker, printMarkerBlock } from "./mcp.js";
import { runSetup, type SetupResult } from "./setup.js";
import { readLocalBinding, resolveBinding, bindingRefused } from "../lib/binding.js";
import { getBinding, setBinding, removeBinding, newWorkspaceId } from "../lib/keystore.js";
import { resolveLauncher, launcherNote, runsOk, onDurablePath, selfCommand, versionStamp, type Resolved } from "../lib/launcher.js";
import { ask, confirm, isInteractive } from "../lib/prompt.js";
import { clean } from "../lib/text.js";
import { card, DOT } from "../lib/card.js";
import {
  answeredElsewhere,
  ELSEWHERE_VALUE,
  emit,
  orgQuestions,
  projectQuestions,
  type Outcome,
} from "../lib/outcome.js";
import { VERSION } from "../version.js";

// RTSC-508: `ask`/`confirm`/`isInteractive` now live in lib/prompt.ts so `auth.ts`
// can use them without closing an import cycle (bind → auth → bind). Re-exported
// here because they have been part of this module's surface since RTSC-269, and
// moving the import in every call site would be churn for no gain.
export { ask, confirm, isInteractive };

// RTSC-91 (DESIGN §13): `retasc bind` — the ONE way to bind a workspace folder to
// exactly one org/project. Explicit, folder-scoped, and LOUD on re-bind. Picks
// (or creates) an org + project, mints a key for that pair, and wires the
// watchdog into THIS folder. No ambient default org is ever consulted.

export type BindOpts = {
  orgId?: string;
  orgName?: string;
  projectId?: string;
  project?: string;
  prefix?: string;
  runtime?: string;
  yes?: boolean;
  /** RTSC-713 — a machine is driving. See `AgentRun` and lib/outcome.ts. */
  json?: boolean;
};

/**
 * The context an agent-driven run carries (RTSC-713).
 *
 * Its presence is the switch: passed, this run reports outcomes and may open the browser
 * door without a TTY; absent, every path behaves exactly as it did before. Nothing about
 * the interactive experience changes, which is the point — this is a new door beside the
 * old one, not a replacement for it.
 */
export type AgentRun = {
  /** Called with the approve URL the moment it exists, before sign-in blocks on the
   *  click. The BROWSER door's callback: since RTSC-879 an agent never takes that door,
   *  so this fires only for a non-agent caller that passes an AgentRun anyway. */
  onUrl: (url: string) => void;
  /** RTSC-879 — a device grant was started. The agent relays this to its human and the
   *  process EXITS; the next `bind --json` resumes it. */
  onDeviceCode?: (d: { url: string; code: string }) => void;
};

/**
 * Render a numbered menu and read one answer, optionally with a trailing extra option.
 *
 * Returns the chosen item, or `undefined` when the trailing option was taken. When there
 * is no trailing option, `undefined` is impossible — every valid answer names an item.
 *
 * Invalid input re-prompts rather than falling through: undefined used to mean
 * BOTH "chose create-new" and "typed garbage", so a typo like `1)` silently
 * created a new org/project instead of selecting option 1 (RTSC-269).
 *
 * The answer must be plain digits. Number() alone accepts "0x4"/"4e0"/"+4"/
 * "4.0", which would route those straight to create-new — the same
 * non-canonical-input-hits-the-destructive-branch bug in a new coat.
 */
async function choose<T>(
  label: string,
  items: T[],
  render: (t: T) => string,
  askFn: (q: string) => Promise<string>,
  extra: string | null,
): Promise<T | undefined> {
  // An empty label means the caller already printed its own heading, and a menu is being
  // appended to it — used by the identity prompt, whose lede is two lines of its own.
  if (label) console.log(`\n${label}:`);
  items.forEach((it, i) => console.log(`  ${i + 1}) ${render(it)}`));
  const extraSlot = items.length + 1;
  if (extra) console.log(`  ${extraSlot}) ${extra}`);
  const highest = extra ? extraSlot : items.length;

  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await askFn("Choose a number: ");
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      if (n >= 1 && n <= items.length) return items[n - 1];
      if (extra && n === extraSlot) return undefined;
    }
    console.log(`Please enter a number between 1 and ${highest}.`);
  }
  throw new Error("no valid choice — aborting");
}

/**
 * Pick from a list interactively. Returns the chosen item, or undefined when the
 * user explicitly picks the trailing "create new" option.
 */
export async function pick<T>(
  label: string,
  items: T[],
  render: (t: T) => string,
  askFn: (q: string) => Promise<string> = ask,
): Promise<T | undefined> {
  if (!items.length) return undefined;
  return choose(label, items, render, askFn, "+ create new");
}

/**
 * Pick from a list with NO create option (RTSC-492).
 *
 * `pick` appends "+ create new" unconditionally, which is right for `bind` — the person
 * running it is setting up their own org and is its owner. It is wrong for someone who
 * just accepted an invite: `createProject` is `requireOwner`, so offering the slot to a
 * member is offering them a refusal. An option that can only fail is worse than no option,
 * because it reads as permission.
 *
 * Never returns undefined, so the caller has no "or else" branch to get wrong. An empty
 * list is the caller's problem to explain, not something to render as a menu of nothing.
 */
export async function pickExisting<T>(
  label: string,
  items: T[],
  render: (t: T) => string,
  askFn: (q: string) => Promise<string> = ask,
): Promise<T> {
  if (!items.length) throw new Error("nothing to choose from");
  return (await choose(label, items, render, askFn, null))!;
}

/**
 * The message to show when `bind` aborts mid-run, or null when there's nothing
 * to say. `bind` commits a new org server-side before the project step; if a
 * later step throws, that org is stranded (no project, no key, no binding) and
 * unreachable from the CLI. There's no CLI-callable org delete, so we surface
 * the id and the resume command instead (RTSC-297, Option 2).
 *
 * It fires ONLY for an org THIS run created that never got bound. A merely
 * SELECTED org (or one already bound before the failure) is not ours to
 * reclaim, and returns null — nothing extra is printed.
 */
export function strandRecoveryHint(args: {
  createdOrgThisRun: boolean;
  orgId?: string;
  bindingWritten: boolean;
}): string | null {
  const { createdOrgThisRun, orgId, bindingWritten } = args;
  if (!createdOrgThisRun || !orgId || bindingWritten) return null;
  return (
    `\n✗ Aborted before this folder was bound. A new org was created (${orgId}) ` +
    `but has no project or key yet — re-run to finish:\n` +
    `    retasc bind --org-id ${orgId}`
  );
}

/**
 * The key this folder should KEEP rather than replace (RTSC-789).
 *
 * `bind` used to mint on every run. The guard that was supposed to stop that
 * (RTSC-262) sat in `preflight` and read `args.orgId && args.projectId`, so it
 * only fired for `retasc bind --org-id X --project-id Y` — the provisioning-script
 * path it was written for. The canonical command is a bare `bind`, which leaves
 * both undefined, so the branch was unreachable for almost every real run: pick
 * the same org and the same project from the menu and it minted anyway. Fourteen
 * keys in one org, three of them the same agent on the same project, and the old
 * ones stay live — two were carrying 89 and 283 sessions.
 *
 * So the check moves to where the target is actually KNOWN, after the interactive
 * pick, and asks the only question that matters: does this folder already hold a
 * key for this exact (org, project)? Flags are irrelevant to that.
 *
 * A DIFFERENT org or project still mints.
 *
 * This names a CANDIDATE, not a decision. It reads the keystore and nothing else,
 * so it cannot know whether the key still works — and "`preflight` already cleared
 * anything the server refused" is not true enough to lean on: that clearing fires
 * only on a literal UNAUTHORIZED, and every other failure walks straight past it.
 * The caller resolves the candidate before keeping it.
 */
export function reusableKey(
  existing: { workspaceId?: string } | null | undefined,
  target: { orgId: string; projectId: string },
  read: (id: string) => { orgId: string; projectId: string; key?: string } | undefined = getBinding,
): string | null {
  if (!existing?.workspaceId) return null;
  const cur = read(existing.workspaceId);
  if (!cur?.key) return null;
  return cur.orgId === target.orgId && cur.projectId === target.projectId ? cur.key : null;
}

/**
 * The binding as the AGENT will see it, or null when the server won't confirm it.
 *
 * One place, because two callers need the same answer for different reasons: the
 * receipt prints it, and the reuse decision above depends on it. Every failure is
 * the same answer here — "the server did not confirm this key" — so the caller
 * decides what that means rather than parsing an error a second time.
 */
async function describeBinding(
  url: string,
  key: string,
): Promise<{ org: string; prefix: string; name?: string } | null> {
  try {
    const b = await resolveBinding(url, key);
    return { org: clean(b.org.name), prefix: clean(b.project.prefix), name: (b.project as any).name };
  } catch {
    return null;
  }
}

/** What this folder is already bound to, as `readLocalBinding` reports it. */
type LocalBinding = NonNullable<ReturnType<typeof readLocalBinding>>;

/**
 * "This folder is already bound — replace it?" (RTSC-262/RTSC-91)
 *
 * Extracted from `bindAction` so `join` inherits it verbatim rather than growing a second,
 * quieter re-bind path (RTSC-492). Silently rebinding someone's working folder is the one
 * outcome neither command may produce, and two implementations of that rule is one too
 * many.
 *
 * `proceed: false` means STOP — either the caller declined, or the requested binding is
 * already in place and there is nothing to do. The exit code for the non-interactive
 * refusal is set here, at the point that knows why.
 *
 * Both callers run this before doing any work that commits state: `bind` before it can
 * create an org, `join` before it mints a key. Neither runs it before the invite is
 * redeemed, because joining an org is not a property of this folder.
 */
export async function rebindGuard(args: {
  cwd: string;
  mcpUrl: string;
  orgId?: string;
  projectId?: string;
  yes?: boolean;
}): Promise<{ proceed: boolean; existing: LocalBinding | null }> {
  // markerOnly (a cloned repo's committed marker, or an entry the CLI can't
  // read a key from) never gates: there is no usable binding to "replace", and
  // minting a key under the existing marker id is exactly what bind is FOR.
  const existing = readLocalBinding(args.cwd);
  if (!existing || existing.markerOnly) return { proceed: true, existing: existing ?? null };

  // Idempotent converge (RTSC-262): re-running with the SAME target is success, not a
  // refusal — a provisioning script must be able to run `retasc bind --org-id X
  // --project-id Y` repeatedly without churning keys.
  if (existing.workspaceId && args.orgId && args.projectId) {
    const cur = getBinding(existing.workspaceId);
    if (cur && cur.orgId === args.orgId && cur.projectId === args.projectId) {
      console.log(
        `Already bound to the requested org/project (${cur.prefix ?? cur.projectId}). Nothing to do.`,
      );
      return { proceed: false, existing };
    }
  }

  let where = "an existing Retasc binding";
  try {
    const b = await resolveBinding(existing.url || args.mcpUrl, existing.key);
    where = `org "${clean(b.org.name)}" / project ${clean(b.project.prefix)}`;
  } catch (e) {
    // RTSC-721 — a binding the server REFUSES is dead, and "Replace it?" is the wrong
    // question to ask about a corpse.
    //
    // This is the months-later return: someone bound a folder, drifted away, and came
    // back after their org was deleted or their key revoked. The local state is intact
    // and points at nothing, and the person standing here does not know `unbind` exists —
    // they ran `bind`, because `bind` is what they remember. Asking them to confirm
    // replacing "an existing Retasc binding" is confusing precisely when they are least
    // equipped to answer; there is nothing usable to preserve.
    //
    // ONLY on a refusal. `bindingRefused` matches the server's UNAUTHORIZED verdict and
    // nothing else — a network blip or a 5xx falls through to the cautious path below,
    // because clearing a healthy credential to fix a problem the machine does not have
    // would be strictly worse than asking a confusing question. That asymmetry is the
    // whole design: misread-refusal costs a question, misread-outage costs a credential.
    //
    // Non-interactive proceeds WITHOUT --yes, unlike the replace path below. Replacing a
    // live binding destroys something; clearing a dead one does not, and an agent-driven
    // `bind` (RTSC-713) that wedged here would need a human to relay a question about
    // state the human cannot see.
    if (bindingRefused(e)) {
      console.log(
        "This folder has a Retasc binding the server no longer accepts — the workspace " +
          "may have been deleted, or the key revoked. There is nothing usable to keep.",
      );
      if (isInteractive() && !(await confirm("Clear it and reconnect?", args.yes))) {
        console.log("Left unchanged.");
        return { proceed: false, existing };
      }
      if (!isInteractive()) console.log("Clearing it and continuing.");
      if (existing.workspaceId) removeBinding(existing.workspaceId);
      // Reuse the workspace id: the marker in this folder (possibly committed) already
      // names it, and bind writes a fresh keystore entry under the same id.
      return { proceed: true, existing };
    }
    /* network/unknown failure — key may still be fine; warn before replacing, as ever */
  }
  console.log(`This folder is already bound to ${where}.`);
  if (await confirm("Replace it?", args.yes)) return { proceed: true, existing };

  // RTSC-262: with no TTY, confirm() answers "no" on its own — and the
  // widened binding lookup makes an existing binding the COMMON case. A
  // provisioning script must not be told success (exit 0) for a no-op.
  if (!isInteractive()) {
    console.error(
      "✗ refusing to replace the existing binding (a DIFFERENT org/project) non-interactively — pass --yes.",
    );
    process.exitCode = 1;
  } else {
    console.log("Left unchanged.");
  }
  return { proceed: false, existing };
}

/**
 * May we install `retasc` on this machine? (RTSC-523)
 *
 * Asked only when it would actually happen. `runsOk` is the same probe
 * `resolveLauncher` opens with, so if `retasc` already works there is nothing to decide and
 * a question would have exactly one possible outcome.
 *
 * A DEFAULT is right here, unlike the sign-in door (RTSC-508), which deliberately has none.
 * A wrong answer costs a couple of seconds per agent start, not a second identity that
 * cannot be merged back. The two questions look alike and are not.
 *
 * NO TTY ⇒ install, silently, exactly as before. That is not laziness about the default: it
 * is the right answer for the person it affects most. The non-technical member of RTSC-497
 * never opens a terminal — her AGENT runs this (RTSC-495/496), with no TTY. She will never
 * type `retasc` herself, but her agent spawns the MCP server on every start, and the npx
 * route would cost her seconds and a network dependency every single time, forever.
 * `--no-install` exists for the developer who wants to decline without a TTY.
 */
export async function chooseInstall(
  /** `--no-install` ⇒ false. Undefined means "not stated". */
  flag?: boolean,
  deps: {
    askFn?: (q: string) => Promise<string>;
    interactive?: () => boolean;
    /** Is a usable `retasc` already on PATH? */
    onPath?: () => boolean;
    remembered?: () => boolean | undefined;
  } = {},
): Promise<boolean> {
  if (flag === false) return false;
  // RTSC-715 — the same durable-PATH question `resolveLauncher` asks. Under npx a bare
  // `retasc` resolves into the npx cache, so this shortcut used to conclude "nothing to
  // install" on a machine that had nothing installed.
  const onPath = deps.onPath ?? (() => onDurablePath("retasc"));
  // Nothing to install, so nothing to ask.
  if (onPath()) return true;

  const remembered = (deps.remembered ?? (() => loadConfig().globalInstall))();
  if (remembered !== undefined) return remembered;

  const interactive = deps.interactive ?? isInteractive;
  if (!interactive()) return true;

  console.log("\nInstall the retasc command on this machine?");
  console.log("  1) Yes, globally          A `retasc` command you can use anywhere.");
  console.log("                            Best if you'll use Retasc in more than one project.");
  console.log("  2) No, run it on demand   Nothing is installed. Your agent fetches it when it");
  console.log("                            starts, which adds a couple of seconds and needs a");
  console.log("                            network connection.");

  const askFn = deps.askFn ?? ask;
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await askFn("Choose a number [1]: ");
    // Either answer leaves this folder bound identically — only the machine differs — so
    // an empty answer taking the default is safe here in a way it is not for the door.
    if (a === "" || a === "1") return remember(true);
    if (a === "2") return remember(false);
    console.log("Please enter 1 or 2.");
  }
  throw new Error("no valid choice — aborting");
}

/** Record the answer, so binding a second folder does not re-ask about the same machine. */
function remember(globalInstall: boolean): boolean {
  patchConfig({ globalInstall });
  return globalInstall;
}

/** The flags that steer the folder half of setup, shared by `bind` and `join`. */
export type WorkspaceSetupOpts = {
  /** RTSC-523 — `--no-install` sets this false; undefined means "not stated". */
  install?: boolean;
  projectId?: string;
  project?: string;
  prefix?: string;
  runtime?: string;
  yes?: boolean;
};


/** Name and create a project by hand — the "start from scratch" ending. */
async function nameAProject(orgId: string): Promise<{ projectId: string; prefix?: string; empty: boolean }> {
  const name = await ask("New project name: ");
  const pfx = (await ask("Project prefix (e.g. ACME): ")).toUpperCase();
  if (!name || !pfx) throw new Error("project name and prefix required");
  const p = (await api.createProject({ orgId, name, prefix: pfx })) as any;
  console.log(`✓ Created project ${p.prefix}.`);
  return { projectId: p.projectId, prefix: p.prefix, empty: true };
}

/**
 * "Where does your work come from?" — the first project, for an org that has none.
 *
 * RTSC-530. Mirrors the Dash's `ProjectSetup`: the trackers first, then "start from
 * scratch" as the last row rather than a footer escape hatch. The Dash records why it is a
 * ROW — as a button it read as a way out of the five real options, which is the wrong
 * framing when most people arriving have work to bring.
 *
 * The import flow is CALLED, not re-implemented (`runImportFlow`). A second copy of the
 * auth prompt, target picker and column mapping is how the two drift, and the mapping is
 * the part that decides where a whole backlog lands.
 *
 * Imported dynamically: `commands/import.ts` imports `pickExisting` from here, so a static
 * import would close a cycle. Same pattern `join` uses for `identityLoop`.
 */
async function firstProject(
  orgId: string,
  orgLabel: string,
): Promise<{ projectId: string; prefix?: string; empty: boolean }> {
  type Src = { source: string; label: string };
  let sources: Src[] = [];
  try {
    sources = (await api.listImportSources()) as Src[];
  } catch {
    // Never block setting up a workspace on the importer list being reachable. A person
    // who just wants an empty project should not be stopped by a source catalogue.
    sources = [];
  }
  if (!sources.length) return nameAProject(orgId);

  const SCRATCH = { source: "", label: "Start from scratch   (name a project; your agents file into it)" };
  const picked = await pickExisting(
    "Where does your work come from?",
    [...sources, SCRATCH],
    (x) => clean(x.label),
  );
  // Compared by REFERENCE, so a source that ever arrives with an empty id cannot be
  // mistaken for the scratch row.
  if (picked === SCRATCH) return nameAProject(orgId);

  const { runImportFlow } = await import("./import.js");
  const done = await runImportFlow({ orgId, orgLabel, source: picked.source });
  // Declining at the import confirmation is not an error, and must not abandon setup —
  // they still asked to bind this folder. Fall back to the other branch of the same fork.
  if (!done) {
    console.log("\nNo import. Let's make an empty project instead.");
    return nameAProject(orgId);
  }
  // An import that ran has work in it by definition — that is what it did.
  return { ...done, empty: false };
}

/**
 * Everything from "which project" to a working folder: pick the project, make `retasc`
 * durable, mint a key for that (org, project), write the binding, and wire the marker.
 *
 * Shared by `bind` and `join` (RTSC-492) rather than copied. The two commands differ only
 * in how they arrive at an org and in whether the caller may create a project; the tail is
 * the same act, and two copies of it would drift — the marker-writing half in particular
 * has already had to be fixed once (RTSC-493) and must never need fixing twice.
 *
 * ORDER. The durable-`retasc` step runs BEFORE the mint, not as a side effect of writing
 * the marker afterwards. A cold `npm i -g` takes tens of seconds and can fail outright; a
 * key minted before it is a live credential stranded behind a step that may never finish.
 * Resolving first also means the launcher is known to every message printed after it.
 */
export async function completeWorkspaceSetup(args: {
  orgId: string;
  /** How to name the org in messages, when the caller knows (join does). */
  orgLabel?: string;
  opts: WorkspaceSetupOpts;
  /** From `rebindGuard`, so a re-bind keeps this folder's workspace id. */
  existing: LocalBinding | null;
  /** False for a plain member: `createProject` needs owner or admin, so the option would only refuse. */
  canCreateProject: boolean;
  /** Called the instant the binding lands on disk — closes `bind`'s strand window. */
  onBound?: () => void;
}): Promise<void> {
  const { orgId, opts, existing } = args;
  const cfg = loadConfig();
  const cwd = process.cwd();
  const org = args.orgLabel ? `"${clean(args.orgLabel)}"` : "this org";

  // --- resolve project (pick / flag / create) --------------------------------
  let projectId = opts.projectId;
  let prefix: string | undefined;
  // RTSC-673 — does this project have anything in it yet? Decides which two sentences
  // close the run. UNKNOWN defaults to "has work": a --project-id we never listed could
  // be either, and telling someone with 200 issues that their project is empty is the
  // worse half of that guess.
  let emptyProject = false;
  if (!projectId && opts.project && opts.prefix) {
    if (!args.canCreateProject) {
      cliError(
        "FORBIDDEN",
        "Only an owner or admin can create a project.",
        `Ask one of them to add one, then pass --project-id <id>.`,
      );
    }
    const p = (await api.createProject({ orgId, name: opts.project, prefix: opts.prefix })) as any;
    projectId = p.projectId;
    prefix = p.prefix;
    emptyProject = true;
    console.log(`✓ Created project ${p.prefix}.`);
  }
  if (!projectId) {
    const { projects } = (await api.listProjects({ orgId })) as any;
    // `counter` is the last ISSUED number, so 0 means nothing was ever filed here —
    // which is the only question RTSC-673 asks of it. It is NOT an open count.
    const list: Array<{ id: string; prefix: string; name: string; counter?: number }> = projects ?? [];

    if (!args.canCreateProject) {
      // A member cannot create one, so an empty org is a dead end here — and it has to say
      // what to ask for, by name. A bare FORBIDDEN from `createProject` would be both
      // wrong (they never asked to create anything) and unactionable.
      if (!list.length) {
        cliError(
          "NO_PROJECTS",
          `Org ${org} has no projects yet, and only an owner or admin can create one.`,
          `Ask one of them to add a project, then finish this folder with:  ${selfCommand(VERSION)} bind --org-id ${orgId}`,
        );
      }
      // One project is not a choice. Asking anyway would be the only question in the
      // common invite path, for an answer that was never in doubt.
      if (list.length === 1) {
        projectId = list[0].id;
        prefix = list[0].prefix;
        emptyProject = projectIsEmpty(list[0]);
      } else if (isInteractive()) {
        const chosen = await pickExisting("Select a project", list, (p) => `${clean(p.prefix)} — ${clean(p.name)}`);
        projectId = chosen.id;
        prefix = chosen.prefix;
        emptyProject = projectIsEmpty(chosen);
      } else {
        cliError(
          "AMBIGUOUS",
          `Org ${org} has ${list.length} projects, so one has to be named.`,
          `Pass --project-id <id> (or run interactively): ${list.map((p) => `${p.prefix}=${p.id}`).join(", ")}`,
        );
      }
    } else if (isInteractive() && list.length === 0) {
      // RTSC-530 — the FROM-SCRATCH case, and the Dash's question rather than ours.
      //
      // `Onboarding.tsx` asks "Where does your work come from?" and offers the five
      // trackers AND "start from scratch" as one fork, because importing is not a separate
      // act: it is one of the ways a first project comes into existence. The CLI used to
      // ask only "New project name:", so someone arriving from Jira had to invent a project
      // they did not want, run `retasc import` afterwards, and leave an empty one behind
      // (deletable by an owner from the Dash since RTSC-812, but still a chore).
      const made = await firstProject(orgId, org);
      projectId = made.projectId;
      prefix = made.prefix;
      emptyProject = made.empty;
    } else if (isInteractive()) {
      const chosen = await pick("Select a project", list, (p) => `${clean(p.prefix)} — ${clean(p.name)}`);
      if (chosen) {
        projectId = chosen.id;
        prefix = chosen.prefix;
        emptyProject = projectIsEmpty(chosen);
      } else {
        const made = await nameAProject(orgId);
        projectId = made.projectId;
        prefix = made.prefix;
        emptyProject = made.empty;
      }
    } else if (list.length === 1) {
      projectId = list[0].id;
      prefix = list[0].prefix;
    } else {
      throw new Error(
        "no project selected — pass --project-id <id>, or --project <name> --prefix <PFX>.",
      );
    }
  }

  // RTSC-810 — a `--project-id` skipped every branch above, so nothing here knew the
  // project's prefix: the key went out nameless (`keyName` was built from `prefix`), the
  // keystore entry was written without `prefix`/`orgName`, and the receipt card printed
  // an empty one. The provisioning form is documented and supported, so it fills the
  // gap the way the pickers do: one list call. Best-effort on the match — a scoped
  // member may hold an id the list does not show, and that folder still has to bind.
  if (projectId && !prefix) {
    const { projects } = (await api.listProjects({ orgId })) as any;
    const hit = (projects ?? []).find((p: { id: string }) => p.id === projectId);
    if (hit) {
      prefix = hit.prefix;
      emptyProject = projectIsEmpty(hit);
    }
  }

  // --- make `retasc` durable BEFORE anything is committed (RTSC-493) ---------
  // The marker names a command something else spawns on every agent start, so it has to
  // name one proved to run on this machine. Resolved (and announced) here so the install
  // can't land after a key exists, and so every later message knows what to tell the user
  // to type.
  //
  // RTSC-523 — and ASK first, because this is the one step in a folder-scoped command that
  // changes the MACHINE. It used to just run `npm install -g`. The project already holds
  // the opposite position everywhere else: `resolveLauncher` leaves a working `retasc`
  // alone ("no surprise installs for someone who already manages their own"), and RTSC-520
  // decided an update must ask. The first command a new developer runs was the one place
  // we did it anyway.
  const install = await chooseInstall(opts.install);
  const launcher: Resolved = resolveLauncher({ version: VERSION, install });
  const note = launcherNote(launcher);
  if (note) console.log(note);

  // --- keep this folder's key if it already names this (org, project), else mint
  //
  // A key is only kept once the SERVER agrees it works. `preflight` clears a binding
  // only on a literal UNAUTHORIZED, so a folder reaches here holding a key of unknown
  // health whenever that check failed some other way — a 5xx, a proxy page, a refusal
  // whose wording drifts off the regex. Keeping such a key silently would strand the
  // folder permanently: `doctor` tells people in exactly that state to re-run `bind`,
  // and `bind` is this path, so it would answer "✓ bound" forever and never heal. The
  // mint-on-every-run this issue removes was doing that healing by accident; it stays,
  // on purpose, as the fallback.
  //
  // The check is not extra work — it IS the receipt's confirmation call, hoisted, and
  // `bound` carries the answer down to the card. The mint path resolves once below,
  // exactly as before.
  const candidate = reusableKey(existing, { orgId, projectId: projectId! });
  let bound = candidate ? await describeBinding(cfg.mcpUrl, candidate) : null;
  // A key that answers for a DIFFERENT project is not this folder's key, whatever the
  // keystore says its ids were. Compared only when the target's prefix is known (a
  // bare --project-id never listed one), because a guess would reject good keys.
  if (bound && prefix && bound.prefix !== clean(prefix)) bound = null;
  const reused = bound !== null;
  const minted: { key: string } = reused
    ? { key: candidate! }
    : ((await api.mintKey({
        orgId,
        projectId: projectId!,
        // RTSC-1156 — only what the human said. This used to default to `claude-code`, and
        // every harness that bound a folder (a Grok Bot onboarding itself via `bind --json`
        // included) was minted as "X's Claude Code". Absent, the server writes "X's agent"
        // and the Dash names the row after the harness that actually connects.
        runtime: opts.runtime,
        // RTSC-859 — bind is the folder door, so this is a workspace key, and the row
        // says so rather than leaving it to the server's default.
        kind: "workspace",
        // RTSC-810 — named after the FOLDER, the leaf only, exactly as the setup-token
        // door has done since RTSC-532: the Keys list is the folder map (`client-a →
        // ENG`), and the old prefix-plus-"key" name told nobody which folder held it.
        // The server cleans the name and falls back to the project's own when the
        // leaf is empty.
        keyName: basename(cwd),
        // RTSC-825 — and as the WORKSPACE, which is the field the Dash reads. `keyName`
        // stays for the legacy label; nothing reads it as a folder any more.
        workspace: basename(cwd),
      })) as any);
  // The key is named in the receipt card below, not here — one mention, in the place
  // that says where it went (RTSC-673).

  // RTSC-92: the secret stays OUT of the repo. Store it in the home keystore
  // keyed by a workspace id; reuse this folder's existing id (so a re-bind, or a
  // teammate's committed marker, keeps the same id) or mint a fresh one.
  const workspaceId = existing?.workspaceId ?? newWorkspaceId();
  setBinding(workspaceId, {
    orgId,
    projectId: projectId!,
    key: minted.key,
    url: cfg.mcpUrl,
    prefix,
    orgName: args.orgLabel,
    boundPath: cwd,
    createdAt: Date.now(),
  });
  args.onBound?.();
  // Per-folder only (local scope), always watchdog. The marker carries only the
  // workspace id — no secret — so ./.mcp.json is safe to commit.
  const marker = installMarker({ workspaceId, scope: "local", launcher, quiet: true });

  // RTSC-780: and the once-per-machine half. Idempotent by construction (each adapter
  // replaces its own entry), so running it on every bind is how a harness installed
  // AFTER the first bind gets picked up without anyone having to know that `retasc
  // setup` exists. Quiet: the receipt below names what it wired, in one row.
  const wired = runSetup({ launcher, quiet: true });

  // Confirm the binding the same way the agent will see it, and print it as the receipt
  // (RTSC-673). Resolved rather than echoed from what we just sent: this is the last
  // chance to notice a folder bound to something other than what was asked for, and a
  // card built from our own inputs could never show that.
  //
  // A reused key was already resolved above, and that answer is the one that decided to
  // keep it — so only a freshly minted key is left to confirm. Still best-effort here:
  // the binding is written and a key we just minted is live by construction, so a
  // network fault at this point is about the confirmation, not about the key.
  if (!bound) bound = await describeBinding(cfg.mcpUrl, minted.key);
  const orgLabel = bound?.org ?? clean(args.orgLabel ?? "");
  const pfx = bound?.prefix ?? clean(prefix ?? "");
  console.log(
    "\n" +
      card(
        `✓ This folder is bound to ${orgLabel} / ${pfx}`,
        [
          { label: "Org", value: orgLabel },
          { label: "Project", value: bound?.name ? `${pfx} ${DOT} ${bound.name}` : pfx },
          {
            label: "Agent key",
            value: `${minted.key.slice(0, 14)}…`,
            note: reused ? "kept, not replaced" : "never leaves ~/.retasc",
          },
          { label: "MCP wired", value: marker.where, note: "secret-free, safe to commit" },
          ...(wired.wired.length
            ? [
                {
                  label: "Harnesses",
                  value: wired.wired.map((w) => w.label).join(", "),
                  note: "every folder",
                },
              ]
            : []),
        ],
        `Agents launched here can only ever read or write ${pfx}.`,
      ),
  );
  // Only when we could write it nowhere. See printMarkerBlock.
  if (!marker.wroteFile && marker.where === "") printMarkerBlock(workspaceId, launcher);

  // RTSC-519 — say that setup FINISHED, and what to do with it.
  //
  // Here rather than in either command, because it is true of both and this is the tail
  // they share. `join` said it and `bind` did not, so the person who set up their own org
  // was left reading a status line and guessing whether anything else was required — while
  // the invited teammate, who arrived through the other command, was told. A line in one
  // caller is a line the other has to remember; a line here is one neither can lose.
  //
  // AFTER the confirmation, and after everything that can throw, so it is only ever
  // printed by a run that actually finished. Nothing below it can fail.
  // RTSC-691 — the restart line prints UNCONDITIONALLY. It was gated on a TTY, which is
  // false in exactly the case that needs it most: when an agent runs `bind`, the agent is
  // the only reader of this output, and it is the one that has to tell the human to
  // restart. A setup that finished but never says so is indistinguishable from one that
  // failed. The "what now" suggestions stay TTY-only — those are for a person browsing.
  console.log(`\n${NEXT_STEP}\n`);
  if (isInteractive()) console.log(`${whatNow(pfx, emptyProject)}\n`);
}

/**
 * The two sentences under `NEXT_STEP`, chosen by whether there is anything to pull yet
 * (RTSC-673).
 *
 * `NEXT_STEP` says how to connect an agent. It cannot say what to ASK it, because the
 * right first thing differs entirely: a project created ten seconds ago has an empty
 * queue, and telling that person to say "next issue" sends them to a blank result as
 * their first experience of the product. Telling the person who just imported 142 issues
 * to "describe what you're building" wastes the work they already have.
 *
 * No count in either branch, deliberately. `projects.counter` is the last ISSUED number,
 * so a project with 200 created and 195 closed still reads 200 — printing it as an open
 * count would be a precise lie. The importer already reports its own totals during the
 * import step, which is where a real number belongs. A true count here needs an
 * open-issue query the CLI does not have yet.
 *
 * "0 issues" is never printed for the empty case either: zero is the expected state for
 * a project someone just named, and stating it as a quantity reads like a failure.
 */
export function projectIsEmpty(p: { counter?: number }): boolean {
  // `counter` is the last ISSUED number, never a count of open work: a project with 200
  // filed and 195 closed still reads 200. So it answers exactly one question — has
  // anything ever been filed here — which is the only one `whatNow` asks. Absent
  // (an older payload, or a caller that never listed the project) reads as NOT empty:
  // telling someone with 200 issues that their project is empty is the worse half of
  // that guess.
  return p.counter === 0;
}

export function whatNow(prefix: string, empty: boolean): string {
  // FLUSH LEFT (RTSC-676). Indented, these read as subordinate to the line above them
  // when they are in fact continuing it — the eye takes the block for a nested detail
  // rather than the instruction it is.
  return empty
    ? `${prefix} is empty, so start by talking with the agent. Tell it what you're\n` +
        `building and it will file the work as it goes.\n\n` +
        `Once there's a backlog, saying "next issue" is how you pull from it.`
    : `There's already work in ${prefix}. Say "next issue" and your agent takes\n` +
        `the top unblocked one and starts.`;
}

/**
 * `retasc bind --setup <token>` — the whole of setup, with nothing to answer (RTSC-495).
 *
 * Not a shortcut through the normal path: a DIFFERENT path, because the person this
 * serves is not the one typing. She owns a marketing agency, she set her org up in the
 * Dash, and she has never opened a terminal. Her agent runs this on her behalf, and an
 * agent's shell is not a TTY — so every question the interactive path asks would either
 * hang or refuse. `ensureSignedIn` refuses first and loudest.
 *
 * It asks nothing because there is nothing left to ask: she signed in, chose her org and
 * her project in the browser, and the token carries those answers here.
 *
 * What it still does, deliberately:
 *  - `rebindGuard` FIRST, before the token is spent. A refusal must leave the token
 *    usable, or a folder mix-up costs her a trip back to the Dash for a new one.
 *  - the RTSC-493 durable-`retasc` step, which matters more here than anywhere else:
 *    she will never type a command again, so a marker naming a binary that does not
 *    resolve is not something she can recover from.
 *
 * Output is written for her, not for her agent: it is relayed to a person who does not
 * know what a marker or a keystore is, and will never see this terminal.
 */
export type Redeemed = {
  key: string;
  orgId: string;
  projectId: string;
  orgName: string;
  projectName: string;
  prefix: string;
};

/** Injected so the ORDER of these four steps can be pinned without a network, a real
 * keystore, or a real folder. Same shape as `chooseInstall`'s, and for the same reason:
 * the interesting paths here are the ones a live run never takes. */
export type SetupDeps = {
  guard?: (a: { cwd: string; mcpUrl: string; yes?: boolean }) => Promise<{
    proceed: boolean;
    existing: LocalBinding | null;
  }>;
  redeem?: (token: string, label: string, workspace: string) => Promise<Redeemed>;
  bind?: (workspaceId: string, entry: Parameters<typeof setBinding>[1]) => void;
  marker?: (a: { workspaceId: string; scope: "local"; launcher: Resolved }) => void;
  /** RTSC-780 — injectable for the same reason `marker` is: this one writes into the
   *  machine's GLOBAL agent configs, so a test that reaches the real implementation
   *  reconfigures the developer's own Claude Code, Codex and Grok. */
  setup?: (a: { launcher: Resolved; quiet: boolean }) => SetupResult;
};

export async function setupFromToken(
  token: string,
  opts: WorkspaceSetupOpts,
  deps: SetupDeps = {},
): Promise<void> {
  const cfg = loadConfig();
  const cwd = process.cwd();
  const guard = deps.guard ?? rebindGuard;
  const redeem =
    deps.redeem ??
    ((t: string, label: string, workspace: string) =>
      api.redeemSetupToken({ token: t, label, workspace }) as Promise<Redeemed>);

  // BEFORE the redeem. `rebindGuard` prints its own explanation and, with no TTY,
  // refuses with exit 1 unless `--yes` — which is exactly the required behaviour, so it
  // is reused rather than restated. No org/project passed: its idempotent-converge
  // shortcut needs ids we do not have yet, and cannot apply to a single-use token anyway.
  const { proceed, existing } = await guard({ cwd, mcpUrl: cfg.mcpUrl, yes: opts.yes });
  if (!proceed) return;

  // Resolve (and if needed install) `retasc` BEFORE the token is spent, so a machine that
  // cannot get a working launcher fails while the code is still redeemable.
  const install = await chooseInstall(opts.install);
  const launcher: Resolved = resolveLauncher({ version: VERSION, install });
  const note = launcherNote(launcher);
  if (note) console.log(note);

  // RTSC-532 — the LEAF name, never the full path. It names the key in the Dash, so it
  // has to be recognisable ("client-a → ENG") without publishing where on her disk it
  // sits. `basename` of the cwd is exactly that.
  //
  // RTSC-825 — sent TWICE, on purpose: once as the legacy `label` and once as the
  // `workspace`. They happen to be the same string here and nowhere is that a rule —
  // the label is a human field a future caller may set to anything, so the folder
  // travels in its own argument rather than being read back out of it.
  const redeemed = await redeem(token.trim(), basename(cwd), basename(cwd));

  const workspaceId = existing?.workspaceId ?? newWorkspaceId();
  (deps.bind ?? setBinding)(workspaceId, {
    orgId: redeemed.orgId,
    projectId: redeemed.projectId,
    key: redeemed.key,
    url: cfg.mcpUrl,
    prefix: redeemed.prefix,
    orgName: redeemed.orgName,
    boundPath: cwd,
    createdAt: Date.now(),
  });
  (deps.marker ?? installMarker)({ workspaceId, scope: "local", launcher });
  // RTSC-780 — same once-per-machine wiring on the agent door. This path has no TTY and
  // no receipt card, so it prints its own line rather than staying silent.
  const wired = (deps.setup ?? runSetup)({ launcher, quiet: true });
  if (wired.wired.length) {
    console.log(`✓ Retasc wired into ${wired.wired.map((w) => w.label).join(", ")}.`);
  }

  // RTSC-532 — name the PATH, not "this folder". A binding is folder → project, and
  // until this line said which folder, a wrong one was undetectable: the agent still
  // calls in, so the Dash shows success while the folder she actually works in has no
  // Retasc tools. Her agent relays this sentence to her, so it is also the last chance
  // to notice.
  console.log(
    `✓ ${clean(cwd)} is connected to ${clean(redeemed.orgName)} / ${clean(redeemed.prefix)}.`,
  );
  // NOT gated on isInteractive(), unlike the interactive path's copy of this line. There
  // is never a TTY here, and this is the one instruction the agent has to pass on — the
  // Dash waits on a tool call that cannot happen until the restart does (RTSC-496).
  console.log(`\n${NEXT_STEP}`);
}

/**
 * What to do with a workspace that is now set up.
 *
 * "or restart it if it's already open" is the load-bearing half. `.mcp.json` is read when
 * an MCP client starts, so an agent already running on this folder will not see Retasc
 * until it restarts — the same trap RTSC-496 records for the Dash's version of this
 * handover, where the screen otherwise waits forever on an agent that can never call in.
 * It bites harder here: `bind` is routinely run from inside a session already open on the
 * folder being bound.
 *
 * Deliberately NOT "run `retasc next`". The agent pulls work over MCP; the CLI's claim
 * commands are a human convenience, and naming one here would teach the wrong first move.
 */
export const NEXT_STEP =
  "Start your agent in this folder, or restart it if it's already open, and it'll pull from the queue.";

/**
 * Sign in first when there is no session at all (RTSC-481, extended to `join` by RTSC-492).
 *
 * `withAuth` deliberately refuses to start a device flow for someone who was
 * never signed in: on an arbitrary call that would be a surprise browser prompt
 * under a misleading "session expired". That reasoning holds for every OTHER
 * command and is left alone. It does not hold for the two commands that are the WHOLE
 * instruction someone is handed — `bind` for a new owner, `join` for an invited teammate —
 * because "run this, but run the other one first" is not a single instruction. So the
 * sign-in is explicit, announced, and only when a human is present to authorize it.
 */
/**
 * RTSC-879 — thrown when a device grant has been started and the human has not approved
 * it yet. NOT a failure: `bindAction` turns it into a CONTINUABLE outcome, because the
 * only thing missing is a click that has not happened yet.
 */
/**
 * How long a resuming `bind --json` waits for the click before handing control back.
 *
 * Ninety seconds is chosen against the agent's loop, not the human's: long enough that
 * a human who clicks while the agent is still talking is picked up on the same call,
 * short enough that a run never looks hung. Being wrong is cheap in one direction only
 * — too short just means one more `bind --json`, too long means an agent that looks
 * dead — so it errs short.
 */
const RESUME_POLL_MS = 90_000;

export class SignInPending extends Error {
  constructor(readonly url: string, readonly code: string) {
    super("sign-in pending: waiting for approval");
  }
}

export async function ensureSignedIn(agent?: AgentRun, opts?: { invited?: boolean }): Promise<void> {
  if (loadConfig().token) return;
  // RTSC-713 — the no-TTY refusal now depends on whether a DOOR exists, not on whether
  // this process has a terminal.
  //
  // The refusal was right about its own case and wrong about the one that matters here.
  // Both doors need a human to act, so a process with nobody watching should stop fast.
  // But an agent-driven run is not nobody watching: the human is in the chat, and the
  // approve URL reaches them there. What actually has to be true is that a browser on
  // this machine can reach the loopback listener, which is exactly what
  // `canOpenBrowser()` decides. So ask it, instead of using "has a TTY" as a proxy for
  // it — the proxy is what made cold `bind` unreachable to an agent.
  if (!isInteractive() && !agent) {
    // RTSC-672 — the stamp rides in the HINT, not the message. `formatError` keeps only
    // the first line of a message (deliberately, to strip stack noise), so a second line
    // here would be silently dropped — which is how a diagnostic aimed at silent failures
    // would itself fail silently.
    cliError(
      "UNAUTHENTICATED",
      `Not signed in. Run \`${selfCommand(VERSION)} login\` first (no TTY here for the device flow).`,
      versionStamp(VERSION).trim(),
    );
  }
  // RTSC-879 — an AGENT always takes the device door, and takes it in two steps.
  //
  // Not the browser door, which is what an agent-driven run used to get. That door sends
  // the human to a URL redirecting to `127.0.0.1` on THIS machine, so it only works when
  // the browser and the CLI share a host. An agent's human may be anywhere, and in a
  // cloud container they always are, so the click lands on a port nobody can reach and
  // the CLI waits out its timeout. `canOpenBrowser` does not catch that: it looks for
  // SSH, CI and an explicit opt-out, and a cloud container sets none of them, so it
  // reports a browser that is not there. A device grant does not care where the human
  // is, which is why it is the door for every agent rather than a fallback for some.
  //
  // Two steps because one does not work: an agent running a blocking command sees no
  // stdout until the process exits, so a code printed above a fifteen-minute wait
  // reaches nobody. START prints and exits; the next `bind --json` FINISHes.
  if (agent) {
    // Two doors stay shut, and only two. A device grant works wherever the human is, so
    // SSH and a container are no longer dead ends — but neither of these is about WHERE
    // the human is:
    //   • CI has nobody watching at all. A code emitted there is read by no one and the
    //     run would ask for it again forever.
    //   • RETASC_NO_BROWSER is a person saying "do not put me through browser auth". A
    //     device grant is still browser auth, just on a different device, so honouring
    //     the switch means honouring it here too.
    if (process.env.CI || process.env.RETASC_NO_BROWSER) {
      throw new Error(
        "no browser door here: " +
          (process.env.CI
            ? "this is CI, and a sign-in code needs a human to approve it. Mint a key on a machine with a browser and set RETASC_MCP_KEY instead."
            : "RETASC_NO_BROWSER is set. Unset it, or sign in on another machine and bind there."),
      );
    }
    const cfg = loadConfig();
    // A grant started against a DIFFERENT backend is not resumable here: Google's half
    // lives in Convex, so polling another deployment asks a server about a code it never
    // issued. Treat it as absent and start a fresh one.
    const stored =
      cfg.pendingDevice && (cfg.pendingDevice.deploymentUrl ?? cfg.deploymentUrl) === cfg.deploymentUrl
        ? cfg.pendingDevice
        : undefined;
    // Resume an approval already in flight. Bounded: `deviceFinish` returns false rather
    // than holding the process open, so every invocation ends promptly whatever the
    // human is doing.
    if (stored && Date.now() < stored.expiresAt) {
      let done: boolean;
      try {
        done = await deviceFinish(stored as PendingDevice, cfg.deploymentUrl, RESUME_POLL_MS);
      } catch (e) {
        // TERMINAL, so the grant must go. `deviceFinish` throws only on things retrying
        // cannot fix — the human declined, the code expired, the client is misconfigured
        // — and a dead grant left in the config is re-loaded by the branch above on every
        // later run, which would rethrow the same refusal forever and leave no way to
        // start a new one short of editing the file by hand.
        patchConfig({ pendingDevice: undefined });
        throw e;
      }
      if (done) {
        patchConfig({ pendingDevice: undefined });
        return;
      }
      throw new SignInPending(
        stored.verificationUriComplete || stored.verificationUri,
        stored.userCode,
      );
    }
    // No grant, or the last one died of old age, or it belongs to another deployment.
    // Clear before starting rather than relying on the write below to overwrite it: if
    // `deviceStart` throws, a dead grant left behind would be re-read on the next run.
    if (cfg.pendingDevice) patchConfig({ pendingDevice: undefined });
    const started = await deviceStart(cfg.loginProvider ?? "github", cfg.deploymentUrl, opts?.invited ? undefined : SITE_URL);
    patchConfig({ pendingDevice: started });
    const url = started.verificationUriComplete || started.verificationUri;
    agent.onDeviceCode?.({ url, code: started.userCode });
    throw new SignInPending(url, started.userCode);
  }

  // RTSC-508: don't name a provider here. `deviceLogin` asks which door, and
  // announcing "GitHub" before the question would be wrong for the invited
  // teammate who signed up through Google — the exact person `join` is for.
  console.error("Not signed in yet — let's do that first.");
  await deviceLogin(undefined, { invited: opts?.invited });
}

export async function bindAction(opts: BindOpts): Promise<void> {
  // RTSC-713 — `--json` is the signal that a machine is driving, and it turns three
  // things on at once: NDJSON on stdout, the browser door without a TTY, and continuable
  // outcomes instead of thrown errors. One flag rather than three, because they are not
  // independently useful: structured output nobody can act on, or a door that leads to a
  // thrown Error, is each worse than neither.
  const agent: AgentRun | undefined = opts.json
    ? {
        onUrl: (url) => emit({ event: "approve_url", url }),
        // RTSC-879 — the device grant emits the SAME event, plus the code. Without this
        // the URL reached an agent only inside the outcome's free-text `next`, so a
        // client parsing NDJSON (which is what `--json` is for) lost the one field it
        // was watching for.
        onDeviceCode: (d) => emit({ event: "approve_url", url: d.url, code: d.code }),
      }
    : undefined;
  const folder = process.cwd();
  // RTSC-722 — the escape option's value is a sentinel, and this is where it stops being
  // an answer. Every suggested question offers "Something else", and the agent is told to
  // put the chosen value in the named flag; without this a human declining the suggestion
  // creates a workspace literally called `__ask_me__`. Strip it here, at the boundary, so
  // no downstream site has to know: the flag reads as unanswered, and the re-ask drops
  // the suggestion this human just declined instead of offering it again.
  const declined = answeredElsewhere(opts);
  if (declined.size) {
    opts = {
      ...opts,
      orgName: opts.orgName === ELSEWHERE_VALUE ? undefined : opts.orgName,
      project: opts.project === ELSEWHERE_VALUE ? undefined : opts.project,
      prefix: opts.prefix === ELSEWHERE_VALUE ? undefined : opts.prefix,
      projectId: opts.projectId === ELSEWHERE_VALUE ? undefined : opts.projectId,
    };
  }
  // What the agent has ALREADY collected, so the re-ask asks only for the rest. Computed
  // after the strip: a sentinel is a decline, never an answer.
  const answered = new Set<string>();
  if (opts.orgName) answered.add("org.name");
  if (opts.project) answered.add("project.name");
  if (opts.prefix) answered.add("project.prefix");
  /** Continuable: say what is missing, exit 0. See lib/outcome.ts for why 0. */
  const pause = (o: Omit<Outcome, "continuable" | "folder">): void => {
    if (agent) emit({ event: "outcome", outcome: { ...o, continuable: true, folder } });
  };
  /** Terminal: nothing to be done from here, so exit non-zero and say so. */
  const stop = (o: Omit<Outcome, "continuable" | "folder">): void => {
    if (agent) emit({ event: "outcome", outcome: { ...o, continuable: false, folder } });
    process.exitCode = 1;
  };

  try {
    await ensureSignedIn(agent);
  } catch (e) {
    if (!agent) throw e;
    // RTSC-879 — started, not failed. The only missing thing is a click, so this is
    // CONTINUABLE: exit 0, tell the agent what to show its human, and let the next
    // `bind --json` resume the same grant. Reported as a failure it would read as
    // "this cannot work here", which is exactly backwards.
    if (e instanceof SignInPending) {
      pause({
        state: "SIGN_IN_PENDING",
        next:
          `Sign-in has started and is waiting for your human. Show them BOTH of these, ` +
          `then run this same command again once they say they have approved it:\n` +
          `  Open: ${e.url}\n  Enter code: ${e.code}\n` +
          `They can open it on any device — a phone, another laptop — it does not have ` +
          `to be this machine.`,
      });
      return;
    }
    // Sign-in was ATTEMPTED and did not complete. Distinct from arriving with no session,
    // which is continuable — collapsing the two is what made the old refusal stop agents
    // that had actually succeeded.
    const why = e instanceof Error ? e.message : String(e);
    stop({
      state: /no browser|no door|RETASC_NO_BROWSER/i.test(why) ? "NO_SIGN_IN_DOOR" : "SIGN_IN_FAILED",
      next:
        `Sign-in did not complete: ${why}. Tell your human what happened. ` +
        `If this machine has no browser (a container, or SSH to a remote box), they can ` +
        `sign in on a machine that does and bind there instead.`,
    });
    return;
  }

  const cfg = loadConfig();

  // --- loud on re-bind -------------------------------------------------------
  // Runs before the org step on purpose: `--org-name` commits an org server-side, and a
  // run that is about to be refused must not leave one behind (RTSC-297).
  const guard = await rebindGuard({
    cwd: process.cwd(),
    mcpUrl: cfg.mcpUrl,
    orgId: opts.orgId,
    projectId: opts.projectId,
    yes: opts.yes,
  });
  if (!guard.proceed) return;
  const existing = guard.existing;

  // --- resolve org (pick / flag / create) ------------------------------------
  // Track whether THIS run created the org (vs. selected a pre-existing one or
  // took one via --org-id). An org is created and committed server-side BEFORE
  // the project step runs, so any abort in the project/mint/bind steps below
  // strands it: no project, no key, no local binding — invisible from the CLI,
  // and (orgs land on the billing rail) accumulating against the account on
  // repeated aborts. There's no CLI-callable org delete, so instead we name the
  // stranded org in the error and print the command to resume (RTSC-297). A
  // merely-SELECTED org must never trigger this — it isn't ours to reclaim.
  let orgId = opts.orgId;
  let createdOrgThisRun = false;
  if (!orgId && opts.orgName) {
    const org = (await api.createOrg({ name: opts.orgName })) as any;
    orgId = org.orgId;
    createdOrgThisRun = true;
    console.log(`✓ Created org "${opts.orgName}".`);
  }
  if (!orgId) {
    const me = (await api.me()) as any;
    const orgs: Array<{ id: string; name: string; slug: string }> = me.orgs ?? [];
    // RTSC-731 — JOIN invites only. RTSC-730 widened what `me.pendingInvites` returns to
    // include invites that merely add projects to a membership somebody already has, and
    // this block asks "join this org, or start your own workspace?" — a question whose
    // premise is false for an existing member, and whose second option creates a SECOND
    // org on the billing rail with no CLI-callable delete (RTSC-297). A widening also
    // must not suppress the single-org shortcut below.
    //
    // Widenings are NOT dropped from the product, only from THIS question: the notice
    // rider still relays them, `whoami` still lists them, `setup_status` asks about them
    // with its own wording, and `accept_invite` still takes them.
    const pendingInvites: Array<{ org: string; orgSlug?: string }> = (
      (me.pendingInvites ?? []) as Array<{ org: string; orgSlug?: string; widensExisting?: boolean }>
    ).filter((i) => !i.widensExisting);
    if (isInteractive()) {
      const chosen = await pick("Select an org", orgs, (o) => `${o.name} (${o.slug})`);
      if (chosen) {
        orgId = chosen.id;
      } else {
        const name = await ask("New org name: ");
        if (!name) throw new Error("org name required");
        orgId = ((await api.createOrg({ name })) as any).orgId;
        createdOrgThisRun = true;
        console.log(`✓ Created org "${name}".`);
      }
    } else if (orgs.length === 1 && (!agent || !pendingInvites.length)) {
      // Unambiguous in a non-interactive run. The invite check is scoped to `agent` ON
      // PURPOSE: a scripted `bind` with one org has bound to that org since RTSC-91, and
      // making a pending invitation suddenly turn that into an error would break existing
      // automation for a question a script cannot answer anyway. The agent CAN ask, so
      // for it the invite outranks the count.
      orgId = orgs[0].id;
    } else if (agent) {
      // RTSC-713 — the handoff, and the state this whole issue exists for.
      //
      // Sign-in SUCCEEDED and the session is on disk. All that is missing is which org
      // this folder is for, which is a question, not a failure. It used to be
      // `throw new Error("no org selected — pass --org-id …")`, written for a human at a
      // shell, and an agent reading a thrown Error correctly concluded the run had failed
      // and stopped one question short of done.
      //
      // Invites are checked BEFORE the count, and outrank a single existing org: someone
      // holding an invitation who also owns a personal org must still be offered the
      // team, or `bind` quietly points this folder at the wrong workspace and the join
      // they were sent never happens.
      const signedInAs = me.user?.email ?? me.user?.name;
      pause({
        state: pendingInvites.length ? "NEEDS_JOIN_OR_CREATE" : "NEEDS_ORG",
        signedInAs,
        orgs,
        pendingInvites: pendingInvites.length ? pendingInvites : undefined,
        missing: ["--org-id or --org-name", "--project or --project-id"],
        // RTSC-720 — the questions as data, so the agent presents them instead of
        // authoring its own from the prose below. On the run that shaped this, the
        // agent handed this state as a sentence asked its three questions in a
        // paragraph; and after a restart the sentence read as a STATUS, so it reported
        // "logged in but no organization" and waited for the human to notice.
        askHuman: pendingInvites.length
          ? [
              {
                id: "onboarding.invite",
                question: `Join "${pendingInvites[0].org}", or start your own workspace?`,
                context:
                  `You have a pending invitation. Joining puts your work in that team's ` +
                  `organization; a new organization cannot be deleted from the terminal ` +
                  `once created.`,
                options: [
                  { value: "join", label: `Join "${pendingInvites[0].org}"`, detail: "Their projects, shared with the team that invited you." },
                  { value: "own", label: "Start my own workspace", detail: "Pick this only if the invite was not meant for this work." },
                ],
                resume: { tool: "join" },
              },
            ]
          : orgQuestions(signedInAs, folder, declined, answered),
        next: pendingInvites.length
          ? `Signed in as ${signedInAs}. They have been invited to ` +
            `${pendingInvites.map((i) => `"${i.org}"`).join(", ")}. ASK whether they want to join ` +
            `that team or start their own workspace — do not choose for them. Joining uses ` +
            `\`join\`; starting fresh re-runs bind with --org-name. Getting this wrong creates a ` +
            `second organization that cannot be deleted.`
          : orgs.length === 0
            ? `Signed in as ${signedInAs}, with no organization yet. Ask what to call their ` +
              `workspace and their first project, then re-run with --org-name, --project and ` +
              `--prefix. Confirm the folder with them first: this will connect ${folder}.`
            : `Signed in as ${signedInAs}, with ${orgs.length} organizations. Ask which one ` +
              `THIS FOLDER is for and which project inside it, then re-run with --org-id and ` +
              `--project-id. Confirm the folder with them: this will connect ${folder}. ` +
              `If the folder plainly matches one of the projects and they pick another, say ` +
              `so once, then do as they say.`,
      });
      return;
    } else {
      throw new Error(
        "no org selected — pass --org-id <id> or --org-name <name> (or run interactively).",
      );
    }
  }

  // RTSC-713 — settle the project BEFORE entering the strand window, when an agent is
  // driving.
  //
  // Ordering, not tidiness. `completeWorkspaceSetup` resolves the project itself and
  // ends in `cliError("AMBIGUOUS", …)` when it cannot, but by then this run may already
  // have created an org — and an abort past that point strands one on the billing rail
  // with no CLI delete (RTSC-297). Asking here means the pause happens while there is
  // still nothing to strand.
  //
  // `firstProject()`, the from-scratch-or-import fork that mirrors the Dash's "where does
  // your work come from?", is TTY-only and stays that way. Its question is now asked in
  // chat instead, which is why the instruction below names the five trackers: without it
  // someone arriving from Jira invents a project they did not want and leaves an empty
  // one behind that cannot be deleted (RTSC-530).
  if (agent && !opts.projectId && !(opts.project && opts.prefix)) {
    const { projects } = (await api.listProjects({ orgId: orgId! })) as any;
    const list: Array<{ id: string; prefix: string; name: string }> = projects ?? [];
    if (list.length === 1) {
      opts = { ...opts, projectId: list[0].id }; // not a choice; asking would be noise
    } else {
      pause({
        state: "NEEDS_PROJECT",
        org: { id: orgId!, name: opts.orgName ?? orgId! },
        projects: list,
        // RTSC-722 — once THIS run created the org, `--org-name` is a trap: the obvious
        // agent move is to replay the previous argv with the missing flag added, which
        // re-enters createOrg, hits `CONFLICT: org slug is taken` and exits 1. The
        // instructions say a non-zero exit means stop, so the run dies one flag from
        // working, with a stranded org. Naming --org-id here is what makes the retry
        // survivable. The REFUSED branch below already warns about this; this pause is
        // the one that reaches it, and did not.
        missing: [
          ...(createdOrgThisRun ? [`--org-id ${orgId}`] : []),
          ...(list.length ? ["--project-id"] : ["--project", "--prefix"]),
        ],
        askHuman: projectQuestions(folder, list, declined),
        next:
          (createdOrgThisRun
            ? `The organization "${opts.orgName}" now EXISTS — it was created by this run. ` +
              `Every retry from here must pass --org-id ${orgId} and must NOT pass ` +
              `--org-name again, which would try to create a second one and fail. `
            : "") +
          (list.length
          ? `That organization has ${list.length} projects. Ask which one THIS FOLDER is ` +
            `for, then re-run with --project-id. Confirm the folder with them: this will ` +
            `connect ${folder}.`
          : `That organization has no projects yet. Ask what they are working on, and ` +
            `whether they want to bring a backlog across from Linear, Jira, Asana, ClickUp ` +
            `or Shortcut rather than start empty. Then re-run with --project and --prefix. ` +
            `Confirm the folder with them: this will connect ${folder}.`),
      });
      return;
    }
  }

  // Everything from here to the binding write is the strand window: the org
  // exists but the workspace isn't bound yet. If we abort in it after creating
  // the org this run, name it and print the resume command (RTSC-297).
  let bindingWritten = false;
  try {
    await completeWorkspaceSetup({
      orgId: orgId!,
      opts,
      existing,
      // `bind` is the OWNER's command — creating a project is the point of its picker.
      canCreateProject: true,
      onBound: () => {
        bindingWritten = true; // strand window closed — the org is now reachable
      },
    });
  } catch (err) {
    const hint = strandRecoveryHint({ createdOrgThisRun, orgId, bindingWritten });
    if (hint) console.error(hint);
    if (agent) {
      // The prose hint above is written for a terminal. An agent needs the same facts as
      // a state it can act on, and this one IS terminal: a stranded org needs a human
      // decision, not another pass.
      stop({
        state: "REFUSED",
        org: { id: orgId!, name: opts.orgName ?? orgId! },
        next:
          `Setup failed after the organization was created: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Tell your human, and pass on that the organization already exists, so a retry ` +
          `must use --org-id ${orgId} rather than --org-name, or they end up with two.`,
      });
      return;
    }
    throw err;
  }

  // Bound. The folder, the org and the project are all settled and on disk, and the one
  // thing left is the restart — which the agent has to ask for, because a client reads
  // its MCP config at startup and nothing here can do it for them.
  pause({
    state: "BOUND",
    org: { id: orgId! },
    // The statement as data (tellHuman, RTSC-717's convention): exact words to relay,
    // so "restart" survives the trip without being reworded into "you may need to".
    tellHuman:
      `Setup is finished and ${folder} is connected. Restart me — start a NEW session, ` +
      `not a resumed one — and then say "show me my issues".`,
    next:
      `Setup is complete and ${folder} is connected. TELL YOUR HUMAN it worked, name the ` +
      `folder and the project, and ask them to restart you — your Retasc tools only load ` +
      `when your client starts, so setup is not finished until they do. A resumed session ` +
      `does not count; it has to be a new one. After the restart, call setup_status.`,
  });
}
