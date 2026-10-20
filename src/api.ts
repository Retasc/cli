import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { loadConfig } from "./config.js";
import { refreshSession, deviceLogin } from "./auth.js";
import { selfCommand } from "./lib/launcher.js";
import { clean as sanitize } from "./lib/text.js";
import { VERSION } from "./version.js";
import { recordRelease } from "./lib/updateNotice.js";
import { publicIp } from "./lib/adClick.js";

// Typed-ish references to the public management functions in convex/manage.ts.
// The CLI is a standalone package, so we reference functions by name rather than
// importing the parent's generated api.
const fns = {
  me: makeFunctionReference<"query">("manage:me"),
  listProjects: makeFunctionReference<"query">("manage:listProjects"),
  createOrg: makeFunctionReference<"mutation">("manage:createOrg"),
  createProject: makeFunctionReference<"mutation">("manage:createProject"),
  renameProjectPrefix: makeFunctionReference<"mutation">("manage:renameProjectPrefix"),
  listKeys: makeFunctionReference<"query">("manage:listKeys"),
  listOrgMembers: makeFunctionReference<"query">("manage:listOrgMembers"),
  mintKey: makeFunctionReference<"action">("manage:mintKey"),
  rotateKey: makeFunctionReference<"action">("manage:rotateKey"),
  revokeKey: makeFunctionReference<"mutation">("manage:revokeKey"),
  createInvite: makeFunctionReference<"action">("manage:createInvite"),
  acceptInvite: makeFunctionReference<"mutation">("manage:acceptInvite"),
  listInvites: makeFunctionReference<"query">("manage:listInvites"),
  revokeInvite: makeFunctionReference<"mutation">("manage:revokeInvite"),
  // Billing (RTSC-279). The CLI is a HUMAN surface (device-login JWT), so these are the
  // very functions the Dash uses — already owner-gated, already org-scoped across every
  // payment link. No key-based path needed here (that's the `billing_summary` MCP tool).
  billingStatus: makeFunctionReference<"query">("manage:billingStatus"),
  chargeHistory: makeFunctionReference<"query">("manage:chargeHistory"),
  orgPayments: makeFunctionReference<"action">("manage:orgPayments"),
  // Imported-identity claim (RTSC-433/473), wired for `join` by RTSC-492 and shared with
  // RTSC-477's standalone `retasc identity`. Member-gated already — nothing was widened
  // server-side for the CLI, and nothing should be.
  // RTSC-524 — the import surface. Owner-gated on the server, authenticated by the same
  // user session every other management call uses.
  listImportSources: makeFunctionReference<"query">("import:listImportSources"),
  listImportTargets: makeFunctionReference<"action">("import:listImportTargets"),
  listImportStatuses: makeFunctionReference<"action">("import:listImportStatuses"),
  listReviewCandidates: makeFunctionReference<"query">("import:listReviewCandidates"),
  runImport: makeFunctionReference<"action">("import:runImport"),
  // RTSC-526: `latestImport` is LIVE progress and is swept after 24h; `importHistory` is
  // permanent and per source, so it is the only thing that can answer "has this org
  // imported from X before?" once the progress row is gone.
  latestImport: makeFunctionReference<"query">("import:latestImport"),
  importHistory: makeFunctionReference<"query">("import:importHistory"),
  // RTSC-749 — the triage door. These are the ONLY CLI calls that must never be
  // reachable with an agent key: they are `convex/triage.ts`, which authenticates through
  // Convex Auth and rejects API keys outright (RTSC-746). The CLI reaches them over the
  // human's device-flow SESSION, like billing and invites — never over the workspace MCP
  // key the issue commands use.
  listQuarantined: makeFunctionReference<"query">("triage:listQuarantined"),
  approveExternal: makeFunctionReference<"mutation">("triage:approveExternal"),
  rejectExternal: makeFunctionReference<"mutation">("triage:rejectExternal"),
  claimableGhosts: makeFunctionReference<"query">("ghosts:claimableGhosts"),
  claimGhost: makeFunctionReference<"mutation">("ghosts:claimGhost"),
  dismissGhostPrompt: makeFunctionReference<"mutation">("ghosts:dismissGhostPrompt"),
  // RTSC-495 — the ONLY unauthenticated call the CLI makes. Redeemed by `bind --setup`
  // on a machine that has never signed in, because the human answered everything in the
  // Dash and it is her agent, not her, running this.
  redeemSetupToken: makeFunctionReference<"action">("setupToken:redeemSetupToken"),
} as const;

function client(): ConvexHttpClient {
  const cfg = loadConfig();
  const c = new ConvexHttpClient(cfg.deploymentUrl);
  if (cfg.token) c.setAuth(cfg.token);
  return c;
}

/**
 * A client that NEVER attaches a session (RTSC-495).
 *
 * `client()` attaches `cfg.token` whenever one exists, and a setup-token redeem must not
 * depend on it either way: the machine usually has no session at all, and where it has a
 * STALE one, sending it risks failing an auth check on a call that never needed identity.
 * Separate function rather than a flag, so "this call is unauthenticated" is visible at
 * the call site instead of buried in an argument.
 */
function anonClient(): ConvexHttpClient {
  return new ConvexHttpClient(loadConfig().deploymentUrl);
}

/**
 * Read a caught backend error into the parts a command wants to show (RTSC-261).
 *
 * `code` is machine-readable, so a command branches on `code === "EXPIRED"`
 * instead of regex-matching prose that any copy edit would break. `hint` is the
 * next step, kept separate so callers can dim or indent it.
 *
 * Both are optional because the sweep is incremental: a backend site still
 * throwing a plain Error (or an OLD deployment this CLI is pointed at) yields
 * `{message}` alone via the same first-line/strip-prefix cleanup used before.
 * Callers must therefore keep any existing string fallback rather than assuming
 * `code` is present.
 */
export function formatError(e: unknown): { code?: string; message: string; hint?: string } {
  const data = (e as any)?.data;
  if (data && typeof data === "object" && typeof data.message === "string") {
    // Type-guard EVERY field, not just `message`: a foreign error carrying
    // `{message: "x", code: {…}}` would otherwise print `✗ [object Object]: x`.
    // And strip control characters — these strings go to `console.error`, so a
    // future converted site that interpolates user data (issue ids, org names)
    // must not be able to smuggle ANSI escapes into the terminal. Mirrors
    // `sanitize` in convex/lib/userError.ts; the two are one wire contract.
    const clean = (v: unknown): string | undefined =>
      // eslint-disable-next-line no-control-regex
      typeof v === "string" ? v.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, " ").trim() : undefined;
    return { code: clean(data.code), message: clean(data.message)!, hint: clean(data.hint) };
  }
  const message = String((e as any)?.message ?? e)
    .split("\n")[0]
    .replace(/^.*?Uncaught Error:\s*/, "")
    .trim();
  // RTSC-478: a failed `fetch` throws the literal `TypeError: fetch failed` and puts the
  // actual diagnosis on `cause.code` — `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` when Node cannot
  // read the machine's CA roots, `SELF_SIGNED_CERT_IN_CHAIN` behind a corporate
  // TLS-inspecting proxy, `ECONNREFUSED`, `ENOTFOUND`. Reading `message` alone throws away
  // the diagnosis Node already handed us, and leaves `retasc login` — the FIRST command a
  // new user runs — dead-ended on a string that names nothing and searches for nothing:
  //     ✗ fetch failed          →     ✗ fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
  // Fallback branch only: a structured backend error (above) already carries its own `code`.
  // Sanitized like every other string we print, because `cause` is not always ours.
  const raw = (e as any)?.cause?.code;
  const code = typeof raw === "string" ? sanitize(raw).trim() : "";
  if (code && !message.includes(code)) return { message: `${message} (${code})` };
  return { message };
}

/**
 * Fail the same way the backend does (RTSC-492).
 *
 * `formatError` truncates a bare Error to its FIRST line, so a multi-line message loses
 * everything after the diagnosis — including the command that fixes it. Some of the stops
 * the CLI has to make are its own (an org with no projects the caller may not create),
 * with no server call to produce a `userError`, and they deserve the same code + message +
 * hint rendering as one that came off the wire.
 */
export function cliError(code: string, message: string, hint?: string): never {
  const e = new Error(`${code}: ${message}`);
  (e as any).data = { code, message, hint };
  throw e;
}

// Does this error mean "the access token is missing/expired", i.e. a refresh
// might fix it? The access-token JWT lives ~1h, so any long-lived login trips
// this. Two shapes surface: our server functions throw `UNAUTHENTICATED …`
// (requireUser), and the Convex platform rejects a stale JWT with "Could not
// verify OIDC token"/"Unauthenticated". Match either, case-insensitively.
// RTSC-261 deliberately does NOT touch this. It gates the refresh-and-retry
// loop, no site converted here throws an auth code, and `formatError` truncates
// to the first line — so routing it through there would add real risk (a missed
// match means a spurious device-flow re-login) for no gain today. It gets a
// `code === "UNAUTHENTICATED"` fast path in the PR that converts lib/auth.ts.
export function isAuthError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e);
  return /unauthenticated|could not verify oidc|oidc token/i.test(msg);
}

/**
 * Run an authed management call, transparently recovering from an expired
 * access token. The two-token design (short access JWT + long refresh token) is
 * the point: the CLI silently rides the refresh token across the hourly access
 * boundary instead of forcing `retasc login` every hour (RTSC-165).
 *
 * On an auth error we try ONE recovery, then retry the call ONCE:
 *   1. If there is no stored token at all, the user was never signed in — this
 *      isn't an expiry, so rethrow the clean "sign in first" error rather than
 *      launching a surprise device flow under a misleading "session expired".
 *   2. `refreshSession()` — swap the refresh token for a fresh access token. A
 *      transient backend failure here (network/5xx/masked "Server Error") is
 *      rethrown by `refreshSession`, so it propagates out as a retryable error
 *      instead of forcing a device-flow re-login on a valid session (RTSC-178).
 *   3. If the refresh token is genuinely expired/invalid (a clean `false`, not a
 *      throw), fall back to a full `deviceLogin()` — but only when stdout is a
 *      TTY, since the device flow prints a code to stdout for a human to
 *      authorize; in a captured/piped context we surface a clear "run `retasc
 *      login`" error instead of hanging or spilling the prompt into someone's
 *      `$(retasc …)` capture.
 * A second auth failure after recovery is real (rethrown) — we never loop.
 */
async function withAuth<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!isAuthError(e)) throw e;

    // No session to recover — never signed in. Surface the original error.
    if (!loadConfig().token) throw e;

    if (await refreshSession()) return await call();

    if (!process.stdout.isTTY) {
      throw new Error(`Session expired and could not refresh. Run \`${selfCommand(VERSION)} login\`.`);
    }
    console.error("Session expired — re-authenticating with GitHub…");
    await deviceLogin();
    return await call();
  }
}

export const api = {
  // RTSC-520 — every login-gated command already makes this call, so the published-version
  // signal rides down on it and costs nothing. Recording it HERE, rather than at each of the
  // nine call sites, is also what keeps the notice out of the machine channel: the MCP proxy
  // never imports this module, so it can never have a signal to print.
  me: async () => {
    const res = await withAuth(() => client().query(fns.me, {}));
    recordRelease((res as { cli?: unknown } | null)?.cli);
    return res;
  },
  listProjects: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.listProjects, args as any)),
  // This machine's address rides along for the backend's ad click match (lib/adClick.ts):
  // a CLI signup has no cookie to send, and the address is the only evidence it carries.
  createOrg: async (args: { name: string; slug?: string }) => {
    const ip = await publicIp();
    return withAuth(() => client().mutation(fns.createOrg, ip ? { ...args, ip } : args));
  },
  createProject: (args: { orgId: string; name: string; prefix: string }) =>
    withAuth(() => client().mutation(fns.createProject, args as any)),
  renameProjectPrefix: (args: { projectId: string; newPrefix: string }) =>
    withAuth(() => client().mutation(fns.renameProjectPrefix, args as any)),
  listKeys: (args: { orgId: string }) => withAuth(() => client().query(fns.listKeys, args as any)),
  listOrgMembers: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.listOrgMembers, args as any)),
  mintKey: (args: {
    orgId: string;
    projectId: string;
    // Accepted by the backend and sent by NOBODY since RTSC-958: a user never names an
    // agent, so the name is always the server's. Kept on the type because older published
    // CLIs still send it and the mutation still has to take it.
    agentName?: string;
    keyName?: string;
    /** RTSC-825 — the folder being bound, which is what the Dash shows as the workspace. */
    workspace?: string;
    runtime?: string;
    /** RTSC-859 — what the key is for. `hosted` = no local runner, ever. */
    kind?: "workspace" | "hosted";
  }) => withAuth(() => client().action(fns.mintKey, args as any)),
  rotateKey: (args: { keyId: string }) => withAuth(() => client().action(fns.rotateKey, args as any)),
  revokeKey: (args: { keyId: string }) =>
    withAuth(() => client().mutation(fns.revokeKey, args as any)),
  // `projectIds` omitted ⇒ every project (RTSC-664).
  createInvite: (args: { orgId: string; expiresInDays?: number; projectIds?: string[] }) =>
    withAuth(() => client().action(fns.createInvite, args as any)),
  acceptInvite: (args: { code: string }) =>
    withAuth(() => client().mutation(fns.acceptInvite, args as any)),
  listInvites: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.listInvites, args as any)),
  revokeInvite: (args: { inviteId: string }) =>
    withAuth(() => client().mutation(fns.revokeInvite, args as any)),
  billingStatus: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.billingStatus, args as any)),
  chargeHistory: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.chargeHistory, args as any)),
  orgPayments: (args: { orgId: string }) =>
    withAuth(() => client().action(fns.orgPayments, args as any)),
  listImportSources: () => withAuth(() => client().query(fns.listImportSources, {})),
  listImportTargets: (args: { orgId: string; source: string; auth: Record<string, string> }) =>
    withAuth(() => client().action(fns.listImportTargets, args as any)),
  listImportStatuses: (args: {
    orgId: string;
    source: string;
    auth: Record<string, string>;
    targetRef: string;
  }) => withAuth(() => client().action(fns.listImportStatuses, args as any)),
  listReviewCandidates: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.listReviewCandidates, args as any)),
  // RTSC-749 — see `fns` above for why these ride the user session, not the MCP key.
  listQuarantined: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.listQuarantined, args as any)),
  approveExternal: (args: { orgId: string; identifier: string; contentHash: string }) =>
    withAuth(() => client().mutation(fns.approveExternal, args as any)),
  rejectExternal: (args: { orgId: string; identifier: string; reason?: string }) =>
    withAuth(() => client().mutation(fns.rejectExternal, args as any)),
  runImport: (args: {
    orgId: string;
    source: string;
    auth: Record<string, string>;
    target: { id: string; key: string; name: string };
    statusMap?: Record<string, string>;
    reviewerByStatus?: Record<string, string>;
  }) => withAuth(() => client().action(fns.runImport, args as any)),
  latestImport: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.latestImport, args as any)),
  importHistory: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.importHistory, args as any)),
  // NOT wrapped in `withAuth`: there is no session to refresh, and its retry path would
  // start a device flow — the exact interactive prompt this whole flow exists to avoid.
  redeemSetupToken: (args: { token: string; label?: string; workspace?: string }) =>
    anonClient().action(fns.redeemSetupToken, args as any),
  claimableGhosts: (args: { orgId: string }) =>
    withAuth(() => client().query(fns.claimableGhosts, args as any)),
  claimGhost: (args: { orgId: string; memberId: string }) =>
    withAuth(() => client().mutation(fns.claimGhost, args as any)),
  dismissGhostPrompt: (args: { orgId: string }) =>
    withAuth(() => client().mutation(fns.dismissGhostPrompt, args as any)),
};
