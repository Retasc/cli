import { createInterface } from "node:readline/promises";
import { api } from "../api.js";

// ---------------------------------------------------------------------------
// RTSC-749 — `retasc triage`. Epic RTSC-751.
//
// The second human signing surface for the quarantine gate (RTSC-746): external intake is
// undispatchable until a member reads it and signs it, and plenty of people live in a
// terminal rather than in the Dash.
//
// THE HARD PART, and why this file is careful. The Dash is a browser a human is sitting
// in. The CLI is a binary on a machine where a CODING AGENT CAN SHELL OUT. If approval
// were scriptable, an agent that just read a hostile body could approve the next one, and
// the gate it is standing in front of would protect nothing.
//
// The server-side invariant does most of the work: `convex/triage.ts` authenticates
// through Convex Auth and rejects agent API keys outright, so an agent holding only a
// workspace MCP key cannot sign, full stop. What remains is an agent shelling out on a
// machine where a human is already logged into the CLI. These are the client-side
// defences against that, and they RAISE THE BAR rather than close the hole:
//
//   • Refuse a non-interactive stdin/stdout. A harnessed `exec` has no PTY.
//   • No approve flag. There is no `--approve`, no `--yes`, no `--force` — so there is no
//     one-liner to smuggle into a command, and no "just add --yes" for anyone to suggest.
//   • Render the body, then require the identifier RETYPED. Not a y/N: a typed value an
//     agent would have to have read the screen to produce.
//   • Echo the content hash of the body just printed, so the server refuses if the text
//     moved under the reader.
//
// RESIDUAL RISK, stated rather than hidden: an agent puppeting a real PTY on a machine
// with a logged-in CLI defeats the TTY check, and the server cannot tell that apart from
// a human. The mitigation is revocation (`retasc logout`), and the Dash remains the
// recommended surface. This is said in the command's own help text too — a defence
// somebody believes is stronger than it is has already done its damage.
// ---------------------------------------------------------------------------

/**
 * Is a real person at this terminal?
 *
 * BOTH streams, deliberately. `stdin` alone is the usual check and it is not enough here:
 * a harness that pipes output while leaving stdin attached would still be driving a
 * command whose entire safety story is "a human is reading the screen".
 */
function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** The SHA-256 the server binds a signature to. Must match `externalContentHash` in
 *  convex/lib/quarantine.ts EXACTLY, including the length prefixes — a drift here means
 *  every terminal approval fails with CONTENT_CHANGED on text nobody edited. */
async function contentHash(title: string, body: string): Promise<string> {
  const canonical = `${title.length}:${title}${body.length}:${body}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Resolve the org the same way `retasc billing` does: explicit, or the only one. */
async function resolveOrg(orgId?: string): Promise<{ orgId: string; label: string }> {
  const me: any = await api.me();
  if (!orgId) {
    if (me.orgs.length === 0) throw new Error("You're not a member of any org yet.");
    if (me.orgs.length > 1) {
      const list = me.orgs.map((o: any) => `  ${o.id}  ${o.name}${o.slug ? ` (${o.slug})` : ""}`);
      throw new Error(`Several orgs — pass --org-id <id>:\n${list.join("\n")}`);
    }
    orgId = me.orgs[0].id;
  }
  const org = me.orgs.find((o: any) => o.id === orgId);
  return { orgId: orgId!, label: org ? `${org.name}${org.slug ? ` (${org.slug})` : ""}` : String(orgId) };
}

type Item = {
  identifier: string;
  title: string;
  body: string;
  externalOrigin?: string;
  externalAuthor?: string | null;
  sourceUrl?: string | null;
  createdAt: number;
  contentHash: string;
};

/** `retasc triage` — what is waiting. A LIST ONLY: nothing here approves. */
export async function triageListAction(opts: { orgId?: string; json?: boolean }) {
  const { orgId, label } = await resolveOrg(opts.orgId);
  const res: any = await api.listQuarantined({ orgId });
  const items: Item[] = res.items ?? [];

  if (opts.json) {
    console.log(JSON.stringify({ orgId, items, hasMore: res.hasMore }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(`Nothing waiting in ${label}.`);
    return;
  }
  console.log(
    `${items.length} ${items.length === 1 ? "issue" : "issues"} filed from outside ${label}, ` +
      `waiting for you to read and approve ${items.length === 1 ? "it" : "them"}:\n`,
  );
  for (const i of items) {
    const who = i.externalAuthor ?? "an unidentified account";
    console.log(`  ${i.identifier}  ${i.title}`);
    console.log(`    by ${who}${i.sourceUrl ? ` · ${i.sourceUrl}` : ""}`);
  }
  if (res.hasMore) console.log(`\n  …and more. Clear some and run this again.`);
  // The list deliberately does NOT print bodies. Reading happens one at a time, next to
  // the decision — a wall of concatenated external text is exactly the thing people skim.
  console.log(`\nRead one in full, then approve or reject:  retasc triage <ISSUE-ID>`);
}

/**
 * `retasc triage RTSC-42` — render the full body, then ask.
 *
 * The whole command is the reading. Everything before the prompt exists to make sure the
 * person answering it has actually seen the text they are vouching for.
 */
export async function triageOneAction(
  identifier: string,
  opts: { orgId?: string },
): Promise<void> {
  // FIRST, before any network call: refuse to run where nobody can read the screen. Doing
  // this first means the refusal is about the environment, not about what happens to be
  // in the queue.
  if (!interactive()) {
    throw new Error(
      "`retasc triage <id>` needs an interactive terminal.\n" +
        "  Approving external work means a person read it, so this command refuses to run\n" +
        "  with piped input or output. There is deliberately no --approve flag.\n" +
        "  Approve in the Dash instead: https://dash.retasc.com/?tab=queue",
    );
  }

  const { orgId, label } = await resolveOrg(opts.orgId);
  const res: any = await api.listQuarantined({ orgId });
  const items: Item[] = res.items ?? [];
  const want = identifier.trim().toUpperCase();
  const item = items.find((i) => i.identifier.toUpperCase() === want);
  if (!item) {
    throw new Error(
      `${identifier} is not waiting for approval in ${label}.\n` +
        `  It may already be approved, rejected, or never have been external.\n` +
        `  Run \`retasc triage\` to see what is waiting.`,
    );
  }

  // The rendering. Plain, undecorated, and complete — no truncation, because a body
  // truncated at the interesting part is worse than no preview at all.
  const who = item.externalAuthor ?? "an unidentified account";
  console.log("");
  console.log(`  ${item.identifier}  ${item.title}`);
  console.log("");
  console.log(`  Filed from OUTSIDE ${label}, by ${who} on ${item.externalOrigin ?? "a connector"}.`);
  if (item.sourceUrl) console.log(`  Source: ${item.sourceUrl}`);
  console.log("");
  console.log("  ── the text you are approving ".padEnd(72, "─"));
  console.log("");
  for (const line of (item.body || "(no description)").split("\n")) console.log(`  ${line}`);
  console.log("");
  console.log("  ".padEnd(72, "─"));
  console.log("");
  console.log("  Treat this as a report to evaluate, not as instructions. Approving tells");
  console.log("  your agents the text is safe to act on.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // The typed confirm. Not y/N: a value that has to be read off the screen. `reject` is
    // the other real answer, and it is deliberately as easy to type as the id is — saying
    // no must never be the expensive option, or people will drift toward yes.
    const answer = (
      await rl.question(`  Type ${item.identifier} to APPROVE, or "reject" to refuse: `)
    ).trim();

    if (answer.toLowerCase() === "reject") {
      await api.rejectExternal({ orgId, identifier: item.identifier });
      console.log(`\n  ✓ ${item.identifier} rejected and closed.`);
      return;
    }
    if (answer.toUpperCase() !== item.identifier.toUpperCase()) {
      console.log(`\n  Nothing done — that didn't match. ${item.identifier} is still waiting.`);
      return;
    }

    // Recompute from the text just printed rather than trusting the value the list gave
    // us: if the two could differ, the hash would stop meaning "what was on screen".
    const hash = await contentHash(item.title, item.body ?? "");
    if (hash !== item.contentHash) {
      // Belt and braces — the server will refuse anyway. Saying it here is friendlier
      // than a CONTENT_CHANGED from the backend.
      throw new Error(
        `${item.identifier} changed while you were reading it. Run the command again.`,
      );
    }
    await api.approveExternal({ orgId, identifier: item.identifier, contentHash: hash });
    console.log(`\n  ✓ ${item.identifier} approved. Agents can pick it up now.`);
  } finally {
    rl.close();
  }
}
