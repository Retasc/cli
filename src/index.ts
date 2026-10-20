#!/usr/bin/env node
import { findBindingByPath } from "./lib/keystore.js";
import { HOOK_PARSERS, NOTICE_SOURCES, foreignToClaudeHook, hookWindowPid, writeWindowConversation, harnessPidFromEnv, healClaudeHookMatcher, leaseNotice, parseClaudeModelSwitchInput, readHeldIssues, updateHookRecordModel, writeHarnessRecord, writeHookRecord } from "./lib/sessionHook.js";
import { Command, Option } from "commander";
import { VERSION } from "./version.js";
import { selfCommand, versionStamp } from "./lib/launcher.js";
import { loadConfig, patchConfig, saveConfig, configPath, isLoggedIn } from "./config.js";
import { installMcp, noteRuntimeIsALabel, normalizeScope, directFormBlocks } from "./commands/mcp.js";
import { runSetup, printSetup } from "./commands/setup.js";
import { installGate, resolveGatePrefix } from "./commands/gate.js";
import { claimAction, releaseAction } from "./commands/claim.js";
import { bindAction, completeWorkspaceSetup, rebindGuard, setupFromToken } from "./commands/bind.js";
import { unbindAction } from "./commands/unbind.js";
import { joinAction } from "./commands/join.js";
import { chooseInviteOrg, chooseInviteProjects } from "./commands/invite.js";
import { identityAction } from "./commands/identity.js";
import { importAction } from "./commands/import.js";
import { doctorAction } from "./commands/doctor.js";
import { updateAction } from "./commands/update.js";
import { billingAction } from "./commands/billing.js";
import { triageListAction, triageOneAction } from "./commands/triage.js";
import { isNetworkError, readLocalBinding, resolveBinding } from "./lib/binding.js";
import {
  whoamiView,
  orgCreatedView,
  projectCreatedView,
  keyListView,
  inviteListView,
} from "./lib/format.js";
import { tidyAction, doneAction } from "./commands/tidy.js";
import {
  issueShowAction,
  issueListAction,
  checkpointAction,
  checkClaimAction,
} from "./commands/issue.js";
import { runProxy } from "./proxy.js";
import { deviceLogin } from "./auth.js";
import { api, formatError } from "./api.js";
import { maybeOfferUpdate } from "./lib/updateNotice.js";
import { isInteractive } from "./lib/prompt.js";
import { AUTO_UPDATE_ENV, AUTO_UPDATE_NOTICE, autoUpdateState, takeAutoUpdateNotice } from "./lib/autoUpdate.js";

const program = new Command();

program
  .name("retasc")
  .description("Retasc — sign in, create projects, mint agent API keys, and wire your agent to the MCP server.")
  .version(VERSION);

function requireLogin() {
  if (!isLoggedIn()) {
    // RTSC-671 — `selfCommand` renders the form they actually used. The docs send a
    // new owner through `npx @retasc/cli@latest`, which never puts `retasc` on PATH, so naming
    // it here answers a failure with a second `command not found`.
    console.error(`Not signed in. Run \`${selfCommand(VERSION)} login\` first.`);
    // RTSC-672 — say which build spoke. A stale CLI and a broken one produce the same
    // sentence otherwise, and the people most likely to re-run this are the ones who
    // were just told a fix shipped.
    console.error(versionStamp(VERSION));
    process.exit(1);
  }
}

// RTSC-261: prefer the structured payload, and print `hint` on its own dimmed
// line — the whole reason it's a separate field is that the fix shouldn't be
// buried in the middle of the diagnosis. `formatError` falls back to the old
// string cleanup, so unconverted backend sites print exactly as they did.
function fail(e: unknown): never {
  const { code, message, hint } = formatError(e);
  console.error(`✗ ${code ? `${code}: ` : ""}${message}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
}

// --- auth ------------------------------------------------------------------

// RTSC-508: two doors, not one. Google sign-in shipped for the web Dash first, so
// an account can exist that GitHub has never heard of — and for that human every
// login-gated command here was unreachable. With no flag the command ASKS, which
// is the only form that helps someone who doesn't know a flag exists.
program
  .command("login")
  .description("Sign in with GitHub or Google (device flow).")
  .option("--github", "Sign in with GitHub, without being asked")
  .option("--google", "Sign in with Google, without being asked")
  .action(async (opts) => {
    try {
      // Naming both is a contradiction, not a preference — and quietly picking
      // one could sign them in through the door that mints a SECOND identity,
      // which nothing in the CLI can undo.
      if (opts.github && opts.google) return fail("Pass --github or --google, not both.");
      await deviceLogin(opts.google ? "google" : opts.github ? "github" : undefined);
      const me = (await api.me()) as any;
      const u = me?.user ?? {};
      console.log(`\n✓ Signed in${u.name ? ` as ${u.name}` : ""}${u.email ? ` <${u.email}>` : ""}.`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("logout")
  .description("Forget the local session.")
  .action(() => {
    const cfg = loadConfig();
    delete cfg.token;
    delete cfg.refreshToken;
    delete cfg.user;
    saveConfig(cfg);
    console.log("✓ Signed out.");
  });

program
  .command("whoami")
  .description("Show THIS folder's org/project binding, plus the signed-in user and their orgs.")
  .option("--json", "Emit the raw payload instead of the summary.")
  .action(async (opts) => {
    // RTSC-91 (§13): lead with the binding for the folder you're in — the same
    // "you are in org X / project Y" heads-up the agent gets — so a human can
    // confirm scope before any work. Resolved from the local key, server-enforced.
    const local = readLocalBinding(process.cwd());
    if (local?.markerOnly) {
      console.log(`This folder → has a Retasc marker but no key on this machine. Run \`${selfCommand(VERSION)} bind\`.\n`);
    } else if (local) {
      try {
        const b = await resolveBinding(local.url || loadConfig().mcpUrl, local.key);
        console.log(`This folder → org "${b.org.name}" / project ${b.project.prefix} (${b.project.name})`);
        console.log(`             as ${b.member.name}${b.member.session ? ` · session ${b.member.session}` : ""}\n`);
      } catch (e: any) {
        // Strip control chars — server-derived text must not smuggle ANSI
        // escapes into trusted output (same rule as doctor's clean()).
        const msg = String(e?.message ?? e).replace(/[\x00-\x1f\x7f]/g, " ");
        // Unreachable ≠ rejected: don't imply a bad key over a dead network.
        if (isNetworkError(e)) console.log(`This folder → binding present, but no usable answer came back: ${msg}\n`);
        else console.log(`This folder → bound, but the key did not resolve: ${msg}\n`);
      }
    } else {
      console.log(`This folder → not bound. Run \`${selfCommand(VERSION)} bind\`.\n`);
    }
    if (!isLoggedIn()) {
      console.log(`Not signed in (management). Run \`${selfCommand(VERSION)} login\` to manage orgs/projects.`);
      return;
    }
    try {
      const me = await api.me();
      // RTSC-521: the binding block above is untouched — it was already the good half of
      // this command. Only the payload dump becomes a summary.
      console.log(opts.json ? JSON.stringify(me, null, 2) : whoamiView(me as any));
    } catch (e) {
      fail(e);
    }
  });

// --- onboarding ------------------------------------------------------------

program
  .command("init")
  .description("Create an org + project, mint an agent key, and wire it into your agent — one shot.")
  .option("--org <name>", "Org name (creates a new org)")
  .option("--org-id <id>", "Use an existing org id instead of creating one")
  .requiredOption("--project <name>", "Project name")
  .requiredOption("--prefix <PREFIX>", "Project prefix, e.g. XEN")
  .option("--runtime <runtime>", "Label for this agent in the Dash (claude-code | codex | grok | …). Omit it and the Dash names the agent after whichever harness connects. Does NOT choose where MCP config is written — `retasc setup` wires every harness on the machine.")
  .option("-y, --yes", "Don't prompt to confirm replacing an existing binding")
  .option("--no-install", "Don't install `retasc` on this machine; wire the pinned npx launcher instead")
  .action(async (opts) => {
    requireLogin();
    try {
      let orgId = opts.orgId as string | undefined;
      if (!orgId) {
        if (!opts.org) return fail("Provide --org <name> to create an org, or --org-id <id>.");
        const org = await api.createOrg({ name: opts.org });
        orgId = (org as any).orgId;
        console.log(`✓ Created org (${(org as any).slug}).`);
      }

      // RTSC-780 follow-up: everything after the org is `bind`'s job now.
      //
      // This command used to mint a key and call `installMcp` itself, which wrote a
      // key-bearing entry for Claude Code and nothing else. When RTSC-780 taught the
      // other three doors (`bind`, `join`, `bind --setup`) to wire every harness on the
      // machine, this one was left behind — so the one command named "onboarding" was
      // the one that still left Codex with no Retasc tools, the exact failure RTSC-780
      // exists to end.
      //
      // Fixed by DELETING the duplicate rather than teaching it the same trick.
      // `completeWorkspaceSetup` already creates the project, mints, writes the keystore
      // binding (which is what an `auto` marker resolves against — without it a marker
      // has nothing to find), installs the folder marker, runs setup and prints the
      // receipt. Two implementations of "set this folder up" is how they drift apart,
      // and this is the second time they did.
      //
      // `--scope` and `--no-watchdog` are gone with it: both described the shape of an
      // entry that is no longer written here. The marker is per-folder and secret-free,
      // and the watchdog is not optional in it.
      const cfg = patchConfig({ defaultProjectPrefix: opts.prefix });
      const guard = await rebindGuard({ cwd: process.cwd(), mcpUrl: cfg.mcpUrl, yes: opts.yes });
      if (!guard.proceed) return;
      await completeWorkspaceSetup({
        orgId: orgId!,
        orgLabel: opts.org,
        opts: {
          project: opts.project,
          prefix: opts.prefix,
          runtime: opts.runtime,
          install: opts.install,
          yes: opts.yes,
        },
        existing: guard.existing,
        canCreateProject: true,
      });
    } catch (e) {
      fail(e);
    }
  });

// `retasc bind` — the canonical per-workspace binder (DESIGN §13). Interactive
// pick/create org → project, mint, wire the watchdog into THIS folder; loud on
// re-bind. Prefer this over `init` for binding an existing org/project.
program
  .command("bind")
  .description("Bind THIS workspace folder to one org + project (pick/create), and wire the watchdog.")
  .option("--org-id <id>", "Use an existing org id")
  .option("--org-name <name>", "Create a new org with this name")
  .option("--project-id <id>", "Use an existing project id")
  .option("--project <name>", "Create a new project with this name (with --prefix)")
  .option("--prefix <PREFIX>", "Prefix for a new project, e.g. ACME")
  .option("--runtime <runtime>", "Label for this agent in the Dash (claude-code | codex | grok | …). Omit it and the Dash names the agent after whichever harness connects. Does NOT choose where MCP config is written — `retasc setup` wires every harness on the machine.")
  .option("-y, --yes", "Don't prompt to confirm replacing an existing binding")
  // RTSC-523 — decline the global install without a TTY. `bind`/`join` ask when a human
  // is present; this is how a scripted run, or a developer whose own agent runs setup,
  // says no up front instead of being installed onto.
  .option("--no-install", "Don't install `retasc` on this machine; wire the pinned npx launcher instead")
  // RTSC-495 — the agent's door. Everything this command normally asks was already
  // answered in the Dash, so the token stands in for all of it and nothing is prompted.
  .option("--setup <token>", "Complete setup from a Dash setup code — no sign-in, no prompts")
  // RTSC-713 — the OTHER agent door, and the one that needs no Dash trip first.
  //
  // Three behaviours, deliberately on one flag because none is useful alone: NDJSON
  // outcomes on stdout, the browser door without a TTY, and continuable states reported
  // at exit 0 instead of thrown. Structured output an agent cannot act on, or a door
  // that leads to a thrown Error, is each worse than neither.
  .option("--json", "Report machine-readable outcomes (for an agent driving setup)")
  .action(async (opts, cmd) => {
    // BEFORE requireLogin: the whole point is a machine that has never signed in. The
    // token is the authorization, and asking for a session here would refuse every
    // caller this flag exists for.
    //
    // `!== undefined`, not truthiness: `--setup ""` is a stated intent to use a setup
    // code, and it must fail as a bad code. Falling through to the interactive path
    // would answer it with "Not signed in", which is the one diagnosis that sends the
    // reader looking in exactly the wrong place.
    if (opts.setup !== undefined) {
      await setupFromToken(opts.setup, opts).catch(fail);
      return;
    }
    // NO requireLogin here (RTSC-670). `bindAction` opens with `ensureSignedIn`, which
    // runs the device flow when there is no session — that IS the documented first step
    // of owner onboarding, and it is the only state a new owner is ever in. This guard
    // predated that (it was correct in 285ec74, when bindAction had no sign-in of its
    // own) and `ensureSignedIn` arriving in 72182c3 left it in front of a door it
    // permanently closed: every `bind` on a fresh machine exited 1 before reaching it.
    //
    // `ensureSignedIn` also refuses BETTER — it says why ("no TTY here for the device
    // flow") where this said only that you weren't signed in, which is the diagnosis
    // that sends someone looking in the wrong place.
    await bindAction(opts).catch(fail);
  });

// `retasc doctor` — verify this folder's binding + flag any illegal global server.
program
  .command("unbind")
  .description("Disconnect THIS folder from Retasc: keystore entry, MCP entry, and revoke the key.")
  .option("-y, --yes", "Don't ask for confirmation")
  .action(async (opts) => {
    await unbindAction(opts).catch(fail);
  });

program
  .command("doctor")
  .description("Check that THIS workspace is correctly and safely bound to one org/project.")
  .action(async () => {
    await doctorAction().catch(fail);
  });

// RTSC-1127 — the upgrade, as its own command. `bind` connects a folder and is the wrong
// tool for someone already connected; `npm i -g` misses every npx-pinned marker.
program
  .command("update")
  .description("Bring every Retasc install and marker on this machine up to date. Retasc also does this by itself in the background (see `retasc config auto-update`).")
  // RTSC-1153 — the proxy's once-a-day background run. Hidden: nobody types it.
  .addOption(new Option("--auto", "background run: silent, skips git-tracked files").hideHelp())
  .allowExcessArguments(false)
  .action((opts: { auto?: boolean }) => {
    updateAction({ auto: Boolean(opts.auto) });
  });

program
  .command("billing")
  .description(
    "Show the org's billing: subscription, what's owed now, and the charge + on-chain payment history across every payment link ever used (owner or admin).",
  )
  .option("--org-id <id>", "Which org (defaults to your only one).")
  .option("--json", "Emit the raw payload instead of the summary.")
  .action(async (opts) => {
    requireLogin();
    await billingAction({ orgId: opts.orgId, json: opts.json }).catch(fail);
  });

// RTSC-749 — the terminal half of the quarantine gate (RTSC-746). Sits beside `billing`
// rather than under `issue`: the `issue` commands go over the workspace MCP key, and this
// one must go over the HUMAN's session — an agent key cannot sign, by design.
program
  .command("triage")
  .argument("[issue]", "The issue to read and decide on. Omit to list what is waiting.")
  .description(
    "Read and approve work filed from OUTSIDE your org. Agents can't pick these up until " +
      "a person approves them, and a person means you: this needs an interactive terminal " +
      "and there is deliberately no --approve flag. The Dash is the recommended surface " +
      "(an agent that can drive a real PTY on this machine could drive this command too).",
  )
  .option("--org-id <id>", "Which org (defaults to your only one).")
  .option("--json", "List as raw JSON. Listing only — deciding is never scriptable.")
  .action(async (issue: string | undefined, opts) => {
    requireLogin();
    if (issue === undefined) {
      await triageListAction({ orgId: opts.orgId, json: opts.json }).catch(fail);
    } else {
      await triageOneAction(issue, { orgId: opts.orgId }).catch(fail);
    }
  });

// --- org / project ---------------------------------------------------------

const org = program.command("org").description("Manage orgs.");
org
  .command("create")
  .requiredOption("--name <name>")
  .option("--slug <slug>")
  .option("--json", "Emit the raw payload instead of the summary.")
  .action(async (opts) => {
    requireLogin();
    try {
      const res = (await api.createOrg({ name: opts.name, slug: opts.slug })) as any;
      console.log(opts.json ? JSON.stringify(res, null, 2) : orgCreatedView(res, opts.name));
    } catch (e) {
      fail(e);
    }
  });

const project = program.command("project").description("Manage projects.");
project
  .command("create")
  .requiredOption("--org-id <id>")
  .requiredOption("--name <name>")
  .requiredOption("--prefix <PREFIX>")
  .option("--json", "Emit the raw payload instead of the summary.")
  .action(async (opts) => {
    requireLogin();
    try {
      const res = (await api.createProject({
        orgId: opts.orgId,
        name: opts.name,
        prefix: opts.prefix,
      })) as any;
      console.log(opts.json ? JSON.stringify(res, null, 2) : projectCreatedView(res, opts.name));
    } catch (e) {
      fail(e);
    }
  });

project
  .command("rename-prefix")
  .description("Rename a project's issue prefix (rewrites every issue id + reference).")
  .requiredOption("--project-id <id>")
  .requiredOption("--prefix <PREFIX>", "New prefix, e.g. RTSC")
  .action(async (opts) => {
    requireLogin();
    try {
      const res = (await api.renameProjectPrefix({
        projectId: opts.projectId,
        newPrefix: opts.prefix,
      })) as any;
      console.log(`✓ Renamed ${res.oldPrefix} → ${res.newPrefix} (${res.issues} issue id${res.issues === 1 ? "" : "s"} rewritten).`);
    } catch (e) {
      fail(e);
    }
  });

// --- keys ------------------------------------------------------------------

const key = program.command("key").description("Mint/rotate/revoke/list agent API keys.");
key
  .command("mint")
  .requiredOption("--org-id <id>")
  .requiredOption("--project-id <id>")
  .option("--runtime <runtime>", "Label for this agent in the Dash (claude-code | codex | grok | …). Omit it and the Dash names the agent after whichever harness connects. Does NOT choose where MCP config is written — `retasc setup` wires every harness on the machine.")
  .option("--name <label>", "Key label")
  // RTSC-859 — say at mint that this key will never have a local runner. Without it
  // the server cannot tell a cloud agent working as documented from a laptop whose
  // config went stale, and hands both the same advice: run `bind`, which a hosted
  // agent cannot.
  .option("--hosted", "This key runs somewhere with no local install (a cloud agent, CI): never told to run bind, never mistaken for a stale setup")
  .option("--install", "Also wire the key into your agent via MCP")
  .option("--scope <scope>", "MCP install scope if --install: local | project", "local")
  .action(async (opts) => {
    requireLogin();
    // RTSC-859 — the two flags contradict each other. `--install` wires a local watchdog;
    // `--hosted` declares there will never be one. Accepting both produced a row the Dash
    // labelled "no local watchdog" for a laptop that was running one, silenced its
    // stale-CLI nudge, and had the proxy's `name_workspace` refused on every start.
    if (opts.hosted && opts.install) {
      fail(new Error("--hosted and --install contradict each other: --install wires a local watchdog, --hosted says this key will never have one. Pick one."));
    }
    try {
      const res = (await api.mintKey({
        orgId: opts.orgId,
        projectId: opts.projectId,
        runtime: opts.runtime,
        keyName: opts.name,
        // RTSC-859 — said only when the caller actually said something. `--hosted` is
        // the word for a cloud agent or CI. `--install` wires the watchdog right here, so
        // that key is a workspace key by construction. A BARE `key mint` says nothing:
        // it is the documented hosted path (RTSC-864, llms.txt) AND the manual-wiring
        // path, and stamping `workspace` on it sent every cloud agent minted that way a
        // firm "re-run bind in that folder" for a folder that never existed. Absent keeps
        // the honest hedge, which is exactly right for a key we know nothing about.
        ...(opts.hosted ? { kind: "hosted" as const } : opts.install ? { kind: "workspace" as const } : {}),
      })) as any;
      console.log(`✓ Minted key: ${res.key}`);
      console.log("  (Shown once — store it now.)");
      // RTSC-864: every paste form, now, while the key is still on the screen. A hosted
      // agent or a container is the reason most people run this command at all, and
      // until now it printed a bare key and left them to invent the config, which for
      // Codex and Grok was not inventable, since no direct-form TOML block existed.
      const cfg = loadConfig();
      console.log("");
      console.log(directFormBlocks(cfg.mcpUrl, res.key));
      if (opts.install) {
        console.log("");
        noteRuntimeIsALabel(opts.runtime);
        installMcp({ url: cfg.mcpUrl, key: res.key, scope: normalizeScope(opts.scope), watchdog: true });
      }
    } catch (e) {
      fail(e);
    }
  });

key
  .command("list")
  .description("List an org's agent keys, newest first.")
  .requiredOption("--org-id <id>")
  .option("--json", "Emit the raw payload instead of the table.")
  .action(async (opts) => {
    requireLogin();
    try {
      const res = (await api.listKeys({ orgId: opts.orgId })) as any[];
      console.log(opts.json ? JSON.stringify(res, null, 2) : keyListView(res));
    } catch (e) {
      fail(e);
    }
  });

key
  .command("rotate")
  .requiredOption("--key-id <id>")
  .action(async (opts) => {
    requireLogin();
    try {
      const res = (await api.rotateKey({ keyId: opts.keyId })) as any;
      console.log(`✓ Rotated. New key: ${res.key}`);
      console.log("  (Shown once — the old key is revoked.)");
    } catch (e) {
      fail(e);
    }
  });

key
  .command("revoke")
  .requiredOption("--key-id <id>")
  .action(async (opts) => {
    requireLogin();
    try {
      await api.revokeKey({ keyId: opts.keyId });
      console.log("✓ Revoked.");
    } catch (e) {
      fail(e);
    }
  });

// --- members / invites -----------------------------------------------------

// An owner invites a human to their org with a single-use, expiring code; the
// invitee redeems it with `retasc join <code>` (authed as themselves via GitHub —
// no email needed). RTSC-137.
const members = program.command("members").description("Invite people to an org and manage invites.");
members
  .command("invite")
  .description("Mint a single-use invite code for an org (owner or admin). Shown once.")
  // RTSC-667 — no longer REQUIRED. Omit it in a terminal and you are asked which org,
  // from the ones you can actually invite into. It stays available because a script
  // has nobody to ask.
  .option("--org-id <id>", "Which org (asked if omitted)")
  .option("--expires-days <n>", "Days until the code expires (1–30, default 7)", (v) => parseInt(v, 10))
  // RTSC-664. Repeatable, and OMITTED MEANS EVERY PROJECT — the behaviour this
  // command has always had, so an existing script keeps working untouched. RTSC-667
  // adds the question a human gets instead, with "All projects" as an explicit first
  // option rather than the thing you get by not answering.
  .option(
    "--project-id <id>",
    "Limit the invitee to this project (repeatable; asked if omitted, all if skipped)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .action(async (opts) => {
    requireLogin();
    try {
      // Ask only for what the command line didn't answer, and fetch only for what we
      // are about to ask: naming --org-id must not cost a round trip for a question
      // nobody sees.
      const orgId: string =
        opts.orgId ?? (await chooseInviteOrg((((await api.me()) as any).orgs ?? []) as any));
      const named: string[] = opts.projectId ?? [];
      const projectIds = named.length
        ? named
        : await chooseInviteProjects(
            ((await api.listProjects({ orgId })) as any).projects ?? [],
          );
      const res = (await api.createInvite({
        orgId,
        expiresInDays: opts.expiresDays,
        ...(projectIds ? { projectIds } : {}),
      })) as any;
      console.log(`✓ Invite code: ${res.code}`);
      console.log(`  Expires ${new Date(res.expiresAt).toISOString().slice(0, 10)}. Single-use — shown once.`);
      // RTSC-492: one command, and one that needs nothing installed first. `join` signs
      // them in, binds the folder and wires their agent, so this must not tell them to run
      // `retasc login` first — nor name a `retasc` binary they don't have yet.
      console.log(`  Share it. In the folder their agent works in, they run:`);
      console.log(`      npx @retasc/cli@latest join ${res.code}`);
    } catch (e) {
      fail(e);
    }
  });

members
  .command("list")
  .description("List an org's invites and their status (owner or admin).")
  .requiredOption("--org-id <id>")
  .option("--json", "Emit the raw payload instead of the table.")
  .action(async (opts) => {
    requireLogin();
    try {
      const res = (await api.listInvites({ orgId: opts.orgId })) as any[];
      console.log(opts.json ? JSON.stringify(res, null, 2) : inviteListView(res));
    } catch (e) {
      fail(e);
    }
  });

members
  .command("revoke")
  .description("Revoke an unused invite (owner or admin).")
  .requiredOption("--invite-id <id>")
  .action(async (opts) => {
    requireLogin();
    try {
      await api.revokeInvite({ inviteId: opts.inviteId });
      console.log("✓ Revoked.");
    } catch (e) {
      fail(e);
    }
  });

// RTSC-492 — the WHOLE of an invited teammate's setup, in one command run from the folder
// their agent will work in: sign in, redeem, claim any imported history, pick the project,
// make `retasc` durable, mint a key, bind the folder and wire the MCP marker. It signs
// itself in (no `requireLogin` gate) because "run this, but run the other one first" is
// not a single instruction.
program
  .command("join")
  .description("Join an org from an invite link and set this folder up completely — one command.")
  .argument("<link>", "The invite link you were given (or just the rtscinv_… code)")
  .option("--no-bind", "Redeem only — don't set this folder up")
  .option("--project-id <id>", "Which project to bind to (skips the picker)")
  .option("--runtime <runtime>", "Label for this agent in the Dash (claude-code | codex | grok | …). Omit it and the Dash names the agent after whichever harness connects. Does NOT choose where MCP config is written — `retasc setup` wires every harness on the machine.")
  // RTSC-477 — name the way back. `--yes` skips the identity question and must never answer
  // it, so the flag that causes the gap is the right place to say how to close it.
  .option(
    "-y, --yes",
    "Don't prompt to replace an existing binding, and skip the identity question (ask it later with `retasc identity`)",
  )
  // RTSC-523 — decline the global install without a TTY. `bind`/`join` ask when a human
  // is present; this is how a scripted run, or a developer whose own agent runs setup,
  // says no up front instead of being installed onto.
  .option("--no-install", "Don't install `retasc` on this machine; wire the pinned npx launcher instead")
  .allowExcessArguments(false)
  .action(async (link: string, opts) => {
    await joinAction(link, opts).catch(fail);
  });

// RTSC-477 — the same question `join` asks, on demand. `join` fires once, at the moment you
// accept an invite; placeholders arrive with EVERY migration, and claiming is per source, so
// the question recurs and needed a surface that recurs with it.
//
// No `-y/--yes`, and no `identity claim <name>` subcommand, on purpose: a claim is
// irreversible and moves dispatch routing, so it is never answered on a script's behalf.
// `allowExcessArguments(false)` therefore rejects `retasc identity claim …` outright rather
// than ignoring the words and prompting anyway.
program
  .command("identity")
  .description(
    "Link imported history to your account: shows the people a migration carried into this org and asks which one is you.",
  )
  .option("--org-id <id>", "Which org (defaults to your only one).")
  .allowExcessArguments(false)
  .action(async (opts) => {
    requireLogin();
    await identityAction({ orgId: opts.orgId }).catch(fail);
  });

// RTSC-524 — bring another tracker across without leaving the terminal. The status
// mapping is ASKED, never guessed: a source lets its users name their own columns, so the
// only honest way to know what one means is the human running the import (the reasoning is
// recorded in convex/lib/importAdapter.ts, which deleted the name-based heuristics after a
// `Rejected` column imported live work as `canceled`, out of dispatch, silently).
program
  .command("import")
  .description("Bring a Linear/Jira/Asana/ClickUp/Shortcut project across into a new Retasc project.")
  .option("--org-id <id>", "Which org to import into (defaults to your only one).")
  .option("--source <source>", "Skip the source picker: linear | jira | asana | clickup | shortcut")
  // No `--token`: a credential passed as an argument lands in shell history and in `ps`.
  // Secrets are read with echo off, or from RETASC_IMPORT_<FIELD>.
  .option("-y, --yes", "Skip the final confirmation (the column mapping is still asked)")
  .allowExcessArguments(false)
  .action(async (opts) => {
    requireLogin();
    await importAction({ orgId: opts.orgId, source: opts.source, yes: opts.yes }).catch(fail);
  });

// --- mcp wiring ------------------------------------------------------------

// RTSC-780 — the once-per-machine half of setup. `bind` runs this itself the first
// time, so most people never type it; it exists on its own for the second harness
// installed after a bind, and for re-running after an upgrade moved the launcher.
program
  .command("setup")
  .description("Detect the MCP harnesses on this machine and wire Retasc into each, once.")
  .option("--no-install", "Don't install `retasc` on this machine; wire the pinned npx launcher instead")
  .allowExcessArguments(false)
  .action((opts) => {
    printSetup(runSetup({ install: opts.install, quiet: true }));
  });

const mcp = program.command("mcp").description("Wire the Retasc MCP server into your agent.");
mcp
  .command("install")
  .description("Register the Retasc MCP server with your agent (Claude Code) or write .mcp.json.")
  .requiredOption("--key <key>", "A Retasc API key (from `retasc key mint`)")
  .option("--scope <scope>", "local | project (per-folder only)", "local")
  .option("--url <url>", "Override the MCP URL")
  .option("--no-watchdog", "Wire a plain direct connection instead of the liveness watchdog (default: watchdog on)")
  .action((opts) => {
    const cfg = loadConfig();
    installMcp({ url: opts.url ?? cfg.mcpUrl, key: opts.key, scope: normalizeScope(opts.scope), watchdog: opts.watchdog });
  });

// Internal: the watchdog proxy, spawned by the harness (not for manual use).
mcp
  .command("proxy", { hidden: true })
  .description("Run the liveness watchdog proxy (spawned by your harness; wired by mcp install).")
  .action(() => runProxy());

// RTSC-820 — what a harness's SessionStart hook runs. Reads the harness's JSON on stdin
// and leaves the session id where the proxy will find it. Exits 0 no matter what: a
// hook that fails must never fail the session it was told about.
const hook = program.command("hook").description("Harness hook handlers (wired by `retasc setup`).");
hook
  .command("session-start")
  .description("SessionStart hook: record this session's transcript id for the proxy.")
  // RTSC-822 — WHICH harness is speaking. Every payload shape differs (Codex has no
  // SessionStart and sends `prompt`; Cursor sends `workspace_roots` and no `cwd` at
  // all), so the parser cannot be guessed from the JSON without reading fields one
  // harness means and another does not.
  //
  // Defaults to claude-code because hooks wired before this option existed run the
  // bare `retasc hook session-start`, and those machines must keep working untouched.
  .option("--harness <id>", "Which harness's payload to expect.", "claude-code")
  .action(async (opts: { harness?: string }) => {
    try {
      // The hook is wired machine-wide, so it fires in every folder the harness opens.
      // Only a folder bound to Retasc has a proxy to hand the id to; anywhere else a
      // record would be a note about a project Retasc was never told about.
      if (process.stdin.isTTY) return;
      const harness = (opts.harness || "claude-code").toLowerCase();
      const parse = HOOK_PARSERS[harness];
      // An unknown harness records NOTHING. A wrong parser would read a field that
      // harness never meant and write a confident, wrong row on the Agents page.
      if (!parse) return;
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      // RTSC-1154 — our Claude Code hook also runs inside Cursor and Grok, which both load
      // ~/.claude/settings.json. Their own hook (or none) speaks for them; this one says
      // nothing there rather than filing their session under Claude Code.
      if (harness === "claude-code" && foreignToClaudeHook(raw)) return;
      const parsed = parse(raw) as
        | { sessionId: string; cwd: string; source?: string; model?: string; agentType?: string; agentId?: string; transcriptPath?: string }
        | null;
      // RTSC-1150 — the Claude Code process this hook speaks for. Claude Code only: a Codex
      // hook launched from a Claude Code shell inherits that shell's CLAUDE_PID, and must
      // not speak for it. A subagent is not the window's conversation.
      const pid = parsed && harness === "claude-code" && !parsed.agentId ? harnessPidFromEnv() : undefined;
      // RTSC-1150 — a /clear is a new conversation in a process whose proxy has already
      // read this folder's record and never reads it again, so rewriting it there serves
      // nothing, and a fresh `at` could be adopted by ANOTHER window starting in the
      // same folder within the minute.
      if (parsed && parsed.source !== "clear" && findBindingByPath(parsed.cwd)) {
        // RTSC-821 — model/agentType/agentId ride along when the payload has them.
        // Claude Code omits `model` from some payloads, so the record simply carries
        // less; the id is what makes the record worth writing.
        writeHookRecord({
          harness,
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          at: Date.now(),
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.agentType ? { agentType: parsed.agentType } : {}),
          ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
          // RTSC-832 — the proxy reads the model out of this. Stays on this machine.
          ...(parsed.transcriptPath ? { transcriptPath: parsed.transcriptPath } : {}),
        });
      }
      // RTSC-1155 — every other harness: record which conversation its window is on, so a
      // proxy that survives /clear notices the change and tells the new conversation which
      // claims the window holds. Codex puts plain stdout from this hook in front of the
      // model ("extra developer context"), so it is told right here as well; Gemini and
      // Cursor take JSON only, and hear it on their next Retasc call.
      if (parsed && harness !== "claude-code") {
        const w = hookWindowPid();
        if (w !== null) {
          const prev = writeWindowConversation(w, parsed.sessionId);
          if (harness === "codex" && prev !== null && prev !== parsed.sessionId) {
            const notice = leaseNotice(readHeldIssues(w));
            if (notice) process.stdout.write(notice + "\n");
          }
        }
      }
      // RTSC-1150 — which process this is, so the proxy can find its harness and leave the
      // claims it holds where the next conversation's hook will read them. Not gated on a
      // binding like the folder record: it names a process, not a project, and a proxy
      // keyed from the environment has no binding here. Skipping it would let a Claude
      // Code nested inside another one be walked past, onto the OUTER window's record.
      if (pid) writeHarnessRecord({ pid, sessionId: parsed!.sessionId, at: Date.now() });
      // RTSC-1150 — a conversation started by /clear or /resume inherits the window's
      // claims, which the proxy goes on renewing, and would otherwise never learn it holds
      // them. Plain stdout from a SessionStart hook is added to the new conversation's
      // context. Only the ids the proxy listed, never a token, and nothing at all when
      // the window holds nothing, so every other session start stays silent.
      if (pid && parsed?.source && NOTICE_SOURCES.has(parsed.source)) {
        const notice = leaseNotice(readHeldIssues(pid));
        if (notice) process.stdout.write(notice + "\n");
      }
      // RTSC-1153 — tell the human, once per machine, that Retasc now updates itself and how
      // to turn that off. Claude Code only (its SessionStart stdout reaches the model; other
      // harnesses' hook output is not known to), the main conversation only, and only in a
      // folder bound to Retasc, so it never appears in a project that has nothing to do with it.
      if (pid && parsed && findBindingByPath(parsed.cwd) && takeAutoUpdateNotice(process.env)) {
        // The same "PASS THIS TO YOUR HUMAN" form every server rider uses, so an agent
        // already knows what to do with it.
        process.stdout.write(`PASS THIS TO YOUR HUMAN: ${AUTO_UPDATE_NOTICE}\n`);
      }
      // RTSC-1150 — a machine wired before `clear` joined the matcher heals itself here.
      if (harness === "claude-code") healClaudeHookMatcher();
    } catch {
      /* never fail the harness's session start */
    } finally {
      process.exitCode = 0;
    }
  });

// RTSC-1155 — Cursor's per-prompt hook. Records which conversation the window is on (a
// /clear or /resume shows up here and nowhere else in Cursor), and answers the JSON
// Cursor requires, always allowing the prompt. Never blocks, never fails the prompt.
hook
  .command("prompt")
  .description("Per-prompt hook (Cursor): record the window's conversation for the proxy.")
  .option("--harness <id>", "Which harness's payload to expect.", "cursor")
  .action(async (opts: { harness?: string }) => {
    try {
      if (process.stdin.isTTY) return;
      const parse = HOOK_PARSERS[(opts.harness || "cursor").toLowerCase()];
      if (!parse) return;
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const parsed = parse(Buffer.concat(chunks).toString("utf8")) as { sessionId: string } | null;
      const w = parsed ? hookWindowPid() : null;
      if (parsed && w !== null) writeWindowConversation(w, parsed.sessionId);
    } catch {
      /* never fail the harness's prompt */
    } finally {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
      process.exitCode = 0;
    }
  });

// RTSC-821 — `/model` mid-conversation. Rewrites the model on this folder's record and
// nothing else; the proxy notices and re-reports. Deliberately does NOT touch `at`: that
// is the window that stops an old record being adopted by a later session, and a switch
// an hour in must not make an hour-old record look new.
hook
  .command("model-switch")
  .description("Claude Code PostModelSwitch hook: update this session's model for the proxy.")
  .action(async () => {
    try {
      if (process.stdin.isTTY) return;
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const parsed = parseClaudeModelSwitchInput(Buffer.concat(chunks).toString("utf8"));
      if (parsed && findBindingByPath(parsed.cwd)) updateHookRecordModel(parsed.cwd, parsed.model, parsed.sessionId);
    } catch {
      /* never fail the harness's model switch */
    } finally {
      process.exitCode = 0;
    }
  });

// Top-level alias so harness config can spawn `retasc mcp-proxy`.
program
  .command("mcp-proxy", { hidden: true })
  .description("Run the liveness watchdog proxy (spawned by your harness).")
  .action(() => runProxy());

// --- gate (commit↔issue traceability) --------------------------------------

const gate = program.command("gate").description("Wire the commit↔issue traceability gate into a repo.");
gate
  .command("install")
  .description("Install a prefix-correct commit-msg hook + check-commit-message Action into this repo.")
  .option("--prefix <PREFIX>", "Project prefix to enforce (default: this folder's bound project)")
  .option("--no-hook", "Skip the local commit-msg hook (CI Action only)")
  .option("--no-action", "Skip the GitHub Action (local hook only)")
  .action(async (opts) => {
    try {
      // RTSC-643: folder-first — the binding is the authoritative identity; the
      // global default (stamped by the last `retasc init`) applies only when the
      // folder is unbound.
      const r = await resolveGatePrefix({
        flag: opts.prefix as string | undefined,
        defaultPrefix: loadConfig().defaultProjectPrefix,
      });
      if (r.source !== "--prefix") console.log(`Prefix ${r.prefix} — from ${r.source}.`);
      if (r.source === "global config") {
        console.log(`  (This folder isn't bound — \`${selfCommand(VERSION)} bind\` makes the prefix folder-scoped.)`);
      }
      if (r.shadowedDefault) {
        console.log(`  ⚠ Ignoring global default prefix ${r.shadowedDefault} — this folder's binding wins.`);
      }
      installGate({ prefix: r.prefix, layers: { hook: opts.hook, action: opts.action } });
    } catch (e) {
      fail(e);
    }
  });

// --- work (claim → worktree) -----------------------------------------------

function addClaimFlags(cmd: ReturnType<typeof program.command>) {
  return cmd
    .option("--id <RTSC-NN>", "Claim one specific issue instead of the next unblocked one")
    .option("--all-lanes", "Pull from every lane, including other humans' work (default: only your lane + unassigned)")
    .option("--base <ref>", "Base ref for the new branch (default: this repo's trunk, from origin/HEAD)")
    .option("--dir <path>", "Parent dir for the worktree (default: beside the main checkout)")
    .option("--no-fetch", "Skip refreshing the base ref from origin first")
    .option("--no-worktree", "Just claim — don't create a worktree")
    .option("--shell", "Spawn a subshell inside the new worktree (exit to return)")
    .option("--print-path", "Print only the worktree path on stdout (for `cd \"$(…)\"`)")
    .option("--json", "Emit the claim + worktree as JSON");
}

// RTSC-148: `claim` takes the issue as a positional too (`retasc claim 143` /
// `retasc claim RTSC-143`). Excess arguments are rejected loudly on both
// commands — Commander otherwise silently drops an undeclared positional, which
// turned "claim this specific issue" into "claim whatever is next".
addClaimFlags(
  program
    .command("claim")
    .description("Claim an issue (RTSC-NN, a bare number, --id, or the next unblocked) and drop into a fresh worktree.")
    .argument("[issue]", "Issue to claim, e.g. RTSC-143 or 143 (defaults to the next unblocked)")
    .allowExcessArguments(false),
).action((issue, opts) => claimAction({ ...opts, issueArg: issue }).catch(fail));

addClaimFlags(
  program
    .command("next")
    .description("Claim the next unblocked issue and drop into a fresh worktree (alias of `claim`).")
    .allowExcessArguments(false),
).action((opts) => claimAction(opts).catch(fail));

// --- branch hygiene (close the worktree+branch claim opened) ----------------

program
  .command("tidy")
  .description("Reconcile rtsc-NN/* branches against their issue status; reap the done+merged ones.")
  .option("--prune", "Delete reapable branches + worktrees (default: dry-run, just report)")
  .option("--force", "Also delete orphans (issue done but branch unmerged)")
  .option("--json", "Emit the reconciled branch table as JSON")
  .option("--base <ref>", "Trunk to measure merge state against (default: this repo's trunk, from origin/HEAD)")
  .option("-y, --yes", "Skip the confirmation before a large prune")
  .option("--only <RTSC-NN>", "Scope the sweep to a single issue's branch (used by the MCP auto-reap)")
  .option("--auto", "Unattended sweep: only reapable branches, capped, with a grace window (used by the proxy)")
  .action((opts) =>
    // Normalize --only to the canonical uppercase id so it matches the branch ids
    // scan() derives (rtsc-181/… → RTSC-181), same as `done` does for --id.
    tidyAction({ ...opts, only: opts.only ? String(opts.only).toUpperCase() : undefined }).catch(fail),
  );

program
  .command("release [issue]")
  .description("Hand a claimed issue back to the queue. Leaves your worktree and branch alone.")
  .option("--id <RTSC-NN>", "The issue to release (or pass it positionally)")
  .requiredOption("--claim-token <token>", "The claim token printed when you claimed it (the server fences on it)")
  .option("--note <text>", "Handoff note for whoever picks it up next")
  .action((issueArg, opts) => releaseAction({ issueArg, ...opts }).catch(fail));

program
  .command("done")
  .description("Mark the current issue (rtsc-NN/ branch, or --id) done and tear down its worktree+branch.")
  .option("--id <RTSC-NN>", "The issue to close (default: derived from the current branch)")
  .option("--force", "Tear down even if the branch isn't merged into the trunk yet")
  .option("--base <ref>", "Trunk to measure merge state against (default: this repo's trunk, from origin/HEAD)")
  // RTSC-709: a read before the write. `done` is one word that closes an issue, and it
  // closed one whose PR was still open. --dry-run shows the readback and the teardown plan
  // without touching anything; -y is for the human who already knows (scripts never prompt).
  .option("--dry-run", "Show what would be closed and torn down, then stop")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action((opts) => doneAction(opts).catch(fail));

// --- reading the queue from a terminal (RTSC-709) ---------------------------
//
// `tidy` and `done` both reason about issue status, and until these existed a human could
// not see the status they were being asked to act on without opening the Dash.

const issue = program.command("issue").description("Read issues from the terminal.");

issue
  .command("show [issue]")
  .description("Show one issue in full (defaults to the current rtsc-NN/ branch's issue).")
  .option("--json", "Emit the raw payload instead of the view.")
  .allowExcessArguments(false)
  .action((issueArg, opts) => issueShowAction({ issueArg, ...opts }).catch(fail));

issue
  .command("list")
  .description("List issues in this folder's project. Defaults to active work.")
  .option("--status <statuses>", "todo | doing | blocked | review | done | canceled (comma-separated)")
  .option("--priority <0-4>", "Filter by priority (0 = none, 1 = urgent)")
  .option("--label <name>", "Filter by label")
  .option("--author <name|me>", "Filter by who created it")
  .option("--assignee <name|me|none>", "Filter by the responsible human")
  .option("--sla <state>", "ok | warning | breaching | breached")
  .option("--limit <n>", "How many to return (default 50, max 200)")
  .option("--json", "Emit the raw payload instead of the table.")
  .action((opts) => issueListAction(opts).catch(fail));

// --- the lease, from a terminal (RTSC-709) ----------------------------------

program
  .command("checkpoint [issue]")
  .description("Record a handoff note on your claimed issue (and renew its lease).")
  .option("--note <text>", "What's done, what's next, and the gotchas")
  // Not a requiredOption, unlike `release`: commander's "required option not specified"
  // can't say WHERE the token comes from, and the action's own error does.
  .option("--claim-token <token>", "The claim token printed when you claimed it (the server fences on it)")
  .allowExcessArguments(false)
  .action((issueArg, opts) => checkpointAction({ issueArg, ...opts }).catch(fail));

program
  .command("check-claim [issue]")
  .description("Does THIS session still hold the issue, and is anything renewing the lease? Exits non-zero if not.")
  .option("--json", "Emit the raw payload instead of the view.")
  .allowExcessArguments(false)
  .action((issueArg, opts) => checkClaimAction({ issueArg, ...opts }).catch(fail));

// --- config ----------------------------------------------------------------

const config = program.command("config")
  .description("Show the resolved CLI config (paths + endpoints).")
  .action(() => {
    const cfg = loadConfig();
    console.log(`config file:    ${configPath()}`);
    console.log(`deployment url: ${cfg.deploymentUrl}`);
    console.log(`mcp url:        ${cfg.mcpUrl}`);
    console.log(`signed in:      ${isLoggedIn(cfg) ? `yes${cfg.user?.name ? ` (${cfg.user.name})` : ""}` : "no"}`);
    console.log(`auto-update:    ${autoUpdateState(process.env, cfg).enabled ? "on" : "off"}`);
  });

// RTSC-1153 — the switch. ON by default; the choice is kept until changed again.
config
  .command("auto-update <state>")
  .description("Turn automatic background updates on or off (default: on). Kept until you change it.")
  .action((state: string) => {
    const s = state.trim().toLowerCase();
    if (s !== "on" && s !== "off") {
      console.error("Use on or off, for example retasc config auto-update off.");
      process.exitCode = 1;
      return;
    }
    // A fresh start either way: an attempt left pending while it was off is not a failure.
    patchConfig({ autoUpdate: s === "on", autoUpdatePendingSince: undefined });
    const st = autoUpdateState(process.env, loadConfig());
    if (s === "off") console.log("Auto-update is off. Run npx -y @retasc/cli@latest update when you want a new version.");
    else if (st.enabled) console.log("Auto-update is on. New versions install in the background and take effect in your next session.");
    else console.log(`Saved as on, but it stays off here because ${st.why === "env" ? `${AUTO_UPDATE_ENV} is set` : "this looks like CI"}.`);
  });

// RTSC-520 — after the command, never during it. A postAction hook is the only place the
// notice can go without interleaving with a command's own output or with a prompt it is in
// the middle of asking, and it fires for whatever ran, so nothing has to remember to call it.
// `maybeOfferUpdate` stays silent unless the command actually talked to the backend and the
// build is genuinely behind; it never throws, because a notice must not fail a command that
// already succeeded.
program.hook("postAction", async () => {
  // RTSC-1153 — the one-time "Retasc now updates itself" line, in a terminal only, and
  // once per machine (the session hook may say it first; whichever does stamps it).
  if (isInteractive() && takeAutoUpdateNotice(process.env)) console.error(AUTO_UPDATE_NOTICE);
  await maybeOfferUpdate();
});

program.parseAsync(process.argv);
