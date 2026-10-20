import { spawn } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { loadConfig, patchConfig } from "./config.js";
import { ask, isInteractive } from "./lib/prompt.js";
import { startBrowserLogin } from "./lib/browserLogin.js";
import { clean } from "./lib/text.js";
import { selfCommand } from "./lib/launcher.js";
import { VERSION } from "./version.js";
import { claimClickRef, deviceLink, newClickRef, SITE_URL } from "./lib/adClick.js";

// The GitHub OAuth App's PUBLIC client id (safe to ship — device flow needs no
// secret). Baked in so `retasc login` works out-of-the-box; override via env.
const GITHUB_CLIENT_ID = process.env.RETASC_GITHUB_CLIENT_ID ?? "Ov23linqRy875IU8OYTW";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// Convex Auth's own public sign-in action. We call it with the "github-device"
// or "google-device" credentials provider; it verifies the upstream token
// server-side and returns a session ({ tokens: { token, refreshToken } }).
const signIn = makeFunctionReference<"action">("auth:signIn");

// RTSC-508 — the Google device flow's two legs, both server-side. Google, unlike
// GitHub, requires a client SECRET on the token exchange, and a published npm
// package cannot hold one. So there is deliberately no Google client id in this
// file either: the CLI never talks to Google directly, so it never needs one, and
// rotating that client becomes a Convex env change with no CLI release.
const googleDeviceStart = makeFunctionReference<"action">("googleDevice:start");
const googleDevicePoll = makeFunctionReference<"action">("googleDevice:poll");

/** Which door to sign in through. Both end in the same kind of Retasc session. */
export type LoginProvider = "github" | "google";

type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** RFC 8628's optional pre-filled form — the URL with `user_code` already in it.
   *  Neither GitHub nor Google documents sending this today, so it is read rather than
   *  relied on: if one ever starts, the page opens filled in and nobody has to retype
   *  eight characters. Absent, we open the plain URL, which is the same page. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  /** RFC 6749 §5.2's error pair, present INSTEAD of a device code on a refusal.
   *  Typed so the failure path can quote the description — the half GitHub writes
   *  for a person — rather than the whole payload. */
  error?: string;
  error_description?: string;
};

async function postForm(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Can this machine plausibly complete a browser round trip (RTSC-691)?
 *
 * Three ways the answer is no, and each of them has cost somebody time:
 *
 *   • **No human.** A scripted or CI run has nobody to click, so waiting is waiting for
 *     nothing.
 *   • **SSH.** `isInteractive()` is true over SSH, which makes a TTY check exactly the
 *     wrong gate. The redirect goes to 127.0.0.1 on the machine whose browser opened it,
 *     so a human clicking on their laptop can never reach a listener on the remote host.
 *     Not slow — impossible.
 *   • **Explicitly opted out.** `RETASC_NO_BROWSER` is the documented switch (see
 *     `cli/src/config.ts`) and is honoured HERE too, not only inside `openBrowser`.
 *     Reading it in one place and not the other produced the worst outcome available: no
 *     browser opens AND the caller still waits out the timeout. Deliberately ONE variable
 *     — a second, undocumented knob is one nobody can find when they need it.
 */
export function canOpenBrowser(agentDriven = false): boolean {
  if (process.env.RETASC_NO_BROWSER) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) return false;
  // RTSC-713 — CI is the case the TTY check used to cover by accident.
  //
  // `agentDriven` drops the TTY requirement, because an agent's shell has no TTY and
  // that was the entire reason cold `bind` was unreachable to one. But "no TTY" was also
  // the only thing holding this door shut in CI, where nobody can click, the listener
  // blocks for its full timeout, and the device flow it falls through to cannot complete
  // either. So the guard the TTY check was silently providing is now stated outright,
  // and it applies on BOTH paths: an agent running inside CI is still CI.
  if (process.env.CI) return false;
  // An agent is a human's hands, not a human's absence — the person is in the chat, and
  // the URL this door prints is relayed to them there. The property that must still hold
  // is that a browser on THIS machine can reach the loopback listener, which is what the
  // SSH check above is for and why it is not relaxed here.
  if (agentDriven) return true;
  return isInteractive();
}

/**
 * Open a URL in the machine's browser, best effort (RTSC-676).
 *
 * BEST EFFORT is the whole contract. There is no browser inside a container or over
 * SSH, which is where `bind` most often runs, so this must never be the only way
 * through and must never turn a failure of its own into a failure of sign-in. It is
 * spawned detached and every outcome is swallowed: the printed URL and code below are
 * the real path, and this only saves the person who does have a browser a trip through
 * their address bar.
 *
 * `xdg-open` on Linux is frequently absent even under a desktop; that is a miss, not an
 * error. `start` needs a shell on Windows, and its first quoted argument is the window
 * TITLE, hence the empty string.
 */
function openBrowser(url: string): void {
  if (process.env.RETASC_NO_BROWSER) return;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
          ? // QUOTED: cmd.exe treats `&` as a command separator, and the sign-in URL is the
          // first here to carry two query parameters (`?port=…&state=…`). Unquoted it
          // opens a truncated link (the Dash then reports "that link is incomplete") and
          // tries to run the remainder as a command.
          ["start", ['""', `"${url}"`]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    // Without this the CLI would wait on a browser that outlives it by hours.
    child.unref();
    // A missing `xdg-open` surfaces here rather than as a throw.
    child.on("error", () => {});
  } catch {
    /* no browser, no shell, no matter — the URL is printed below */
  }
}

/**
 * Print the two lines a human has to act on, identically for both doors, and open the
 * browser for them if this machine has one.
 *
 * The lines are printed FIRST and unconditionally. Someone reading a terminal in a
 * container has to see the URL whatever happened, and an auto-open that silently
 * failed must leave the screen exactly as useful as it was before (RTSC-676).
 *
 * `complete` is RFC 8628's pre-filled URL when the provider sent one. It is opened in
 * preference to the plain one, but never PRINTED in its place: the code stays on its own
 * line so it can be read aloud, retyped on a phone, or pasted into a browser on another
 * machine — none of which a link helps with.
 */
function announceCode(where: string, url: string, code: string, complete?: string): void {
  console.log(`\n  Open: ${url}`);
  console.log(`  Enter code: ${code}\n`);
  console.log(`  Waiting for ${where} authorization…`);
  openBrowser(complete || url);
}

/**
 * Where a code sign-in sends the person: retasc.com's `/cli-device`, which redirects
 * straight to the provider's page and reads the ad click cookie on the way
 * (lib/adClick.ts). Absent for an invited teammate, who goes to the provider directly.
 */
type DeviceHop = { siteUrl: string; ref: string };

/** Run GitHub's device flow (talking to GitHub directly) and return its access token. */
async function githubDeviceToken(hop?: DeviceHop): Promise<string> {
  if (!GITHUB_CLIENT_ID) {
    throw new Error(
      "GitHub client id not configured. Set RETASC_GITHUB_CLIENT_ID (the OAuth App's public Client ID).",
    );
  }

  const start: DeviceStart = await postForm(DEVICE_CODE_URL, {
    client_id: GITHUB_CLIENT_ID,
    scope: "read:user user:email",
  });
  if (!start.device_code) {
    // Say what GitHub said, not what GitHub SENT. The whole response used to be
    // JSON.stringify'd into this message, which put a raw OAuth payload in front of
    // someone whose only question is whether to try again — and buried
    // `error_description`, the one field in it written for a person to read.
    const said = start.error_description ?? start.error;
    throw new Error(
      `GitHub didn't hand back a sign-in code${said ? `: ${clean(said)}` : "."} ` +
        `Check your connection and run \`${selfCommand(VERSION)} login\` again.`,
    );
  }

  // The hop replaces the pre-filled URL too: opening GitHub directly is what skipped the
  // cookie. GitHub has never sent one, so nothing is lost.
  if (hop) announceCode("GitHub", deviceLink(hop.siteUrl, "github", hop.ref), start.user_code);
  else announceCode("GitHub", start.verification_uri, start.user_code, start.verification_uri_complete);

  // Poll GitHub for the access token.
  let intervalMs = (start.interval || 5) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const r = await postForm(TOKEN_URL, {
      client_id: GITHUB_CLIENT_ID,
      device_code: start.device_code,
      grant_type: GRANT,
    });
    if (r.access_token) return r.access_token;
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`GitHub authorization failed: ${r.error_description ?? r.error}`);
  }
  throw new Error("Timed out waiting for GitHub authorization.");
}

/**
 * Run Google's device flow and return its access token (RTSC-508).
 *
 * Structurally the same as the GitHub one, with the two Google calls made by the
 * backend rather than from here — see the note on the function references above.
 * The loop, the interval back-off and the deadline stay client-side: the wait is
 * as long as a human takes to find their browser, which is not something to hold
 * a Convex action open for.
 */
async function googleDeviceToken(convex: ConvexHttpClient, hop?: DeviceHop): Promise<string> {
  const start = (await convex.action(googleDeviceStart, {})) as {
    userCode: string;
    verificationUrl: string;
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
    verificationUrlComplete?: string;
  };

  if (hop) announceCode("Google", deviceLink(hop.siteUrl, "google", hop.ref), start.userCode);
  else announceCode("Google", start.verificationUrl, start.userCode, start.verificationUrlComplete);

  let intervalMs = (start.intervalSeconds || 5) * 1000;
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    // Anything terminal — declined, expired, misconfigured — is thrown by the
    // backend as a readable userError and propagates to the caller's `fail`.
    const r = (await convex.action(googleDevicePoll, { deviceCode: start.deviceCode })) as
      | { status: "pending" }
      | { status: "slowDown" }
      | { status: "ok"; googleToken: string };
    if (r.status === "ok") return r.googleToken;
    if (r.status === "slowDown") intervalMs += 5000;
  }
  throw new Error("Timed out waiting for Google authorization.");
}

/**
 * Which door, when the caller didn't say (RTSC-508).
 *
 * Asked rather than defaulted because the person who needs the second door is
 * precisely the one who cannot be expected to know a flag exists: they signed up
 * through the web Dash with Google, and a GitHub-only prompt is a dead end they
 * have no way to read as one. One keystroke, and only when someone is there to
 * press it.
 *
 * Non-interactive runs keep today's behaviour exactly — GitHub, no prompt — so
 * nothing scripted against `retasc login` changes.
 */
export async function chooseProvider(
  // Injected so the question can be pinned by tests. Picking the wrong door is
  // not a typo you correct on the next run: it signs you in as a SECOND identity
  // with its own membership, and nothing in the CLI can merge them back. Same
  // reasoning as `identityLoop`'s deps — the loud path is the one that must be
  // provable, and a live run only ever exercises the quiet one.
  deps: {
    askFn?: (q: string) => Promise<string>;
    interactive?: () => boolean;
    /** The door the last SUCCESSFUL login used, when there was one. */
    remembered?: LoginProvider;
  } = {},
): Promise<LoginProvider> {
  const askFn = deps.askFn ?? ask;
  const interactive = deps.interactive ?? isInteractive;
  if (!interactive()) return "github";

  // A default exists ONLY when it is a recorded fact about this human — the door
  // they last signed in through successfully. That is the whole rule. Defaulting
  // to GitHub because most people use it would be assuming an answer to a
  // question whose wrong answer is a second identity, for exactly the person
  // this feature exists to serve. A remembered door assumes nothing: it already
  // worked for them once.
  const remembered = deps.remembered;
  const DOORS: Array<{ key: LoginProvider; slot: string; label: string }> = [
    { key: "github", slot: "1", label: "GitHub" },
    { key: "google", slot: "2", label: "Google" },
  ];

  console.log("\nHow do you sign in to Retasc?");
  for (const d of DOORS) {
    console.log(`  ${d.slot}) ${d.label}${d.key === remembered ? "   (last used)" : ""}`);
  }
  const rememberedSlot = DOORS.find((d) => d.key === remembered)?.slot;

  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await askFn(rememberedSlot ? `Choose a number [${rememberedSlot}]: ` : "Choose a number: ");
    // Empty is an answer only when there is something true to answer WITH.
    if (a === "" && remembered) return remembered;
    const hit = DOORS.find((d) => d.slot === a);
    if (hit) return hit.key;
    console.log("Please enter 1 or 2.");
  }
  throw new Error("no valid choice — aborting");
}

/**
 * Sign in through the browser and persist the session (RTSC-691).
 *
 * Prints the URL BEFORE waiting, unconditionally, for the same reason `announceCode`
 * does: an auto-open that silently failed must leave the screen exactly as useful as it
 * was. On a headless box the printed link is the whole path, and when an agent is
 * driving, that printed line is what it relays to its human.
 */
async function browserLogin(
  deploymentUrl: string,
  dashUrl: string,
  onUrl?: (url: string) => void,
  invited?: boolean,
): Promise<void> {
  const { url, port, wait } = await startBrowserLogin(dashUrl, { invited });
  // RTSC-713 — hand the URL to the caller BEFORE the wait, not only to the terminal.
  //
  // `startBrowserLogin` was already split in two so the URL exists before blocking; this
  // is the other half of that split finally being used. An agent backgrounds this
  // process and tails its output, so the URL reaching stdout here is what lets it post a
  // clickable link into the chat while this call is still blocked on the click. Printed
  // AND opened AND handed back: the browser popping up is the nice case, the link in the
  // chat is the one that always works.
  onUrl?.(url);
  console.log(`\n  Open: ${url}\n`);
  console.log("  Waiting for you to approve it in the browser…");
  openBrowser(url);

  const { code } = await wait();
  const convex = new ConvexHttpClient(deploymentUrl);
  const res: any = await convex.action(signIn, {
    provider: "cli-browser",
    params: { code, port },
  });
  const tokens = res?.tokens;
  if (!tokens?.token) throw new Error("Sign-in did not return a session token.");
  // No `loginProvider` recorded: this door does not name an upstream identity, and
  // writing one would make the next device-flow default a guess rather than a memory of
  // what actually worked.
  patchConfig({ token: tokens.token, refreshToken: tokens.refreshToken });
}

/**
 * RTSC-879 — the device grant, split into START and FINISH so an agent can drive it.
 *
 * WHY A SPLIT. `deviceLogin` prints the code and then blocks in a poll loop until a
 * human clicks. That is right for a person at a terminal and useless to an agent: an
 * agent running a blocking command sees no stdout until the process exits, so a URL
 * printed at the top of a five-minute wait reaches nobody. The code below is the same
 * grant, cut in half at the only place it can be cut — after the provider has issued a
 * code and before anyone waits — so the caller can print, EXIT, and come back.
 *
 * WHY THIS AND NOT THE BROWSER DOOR. `browserLogin` opens a loopback listener and sends
 * the human to a URL that redirects to `127.0.0.1` ON THIS MACHINE. That works when the
 * browser and the CLI share a host. An agent's human may be anywhere — and in a cloud
 * container they are definitionally elsewhere, so the click lands on a port nobody can
 * reach and the CLI waits out its timeout. A device grant has no such requirement: the
 * approval happens entirely at the provider, and this side only polls. It is the door
 * that works whether the human is at this keyboard or not.
 *
 * The state below is everything FINISH needs and nothing more. It is not a credential:
 * a device code is single-use, scoped to one pending grant, and worthless after it
 * expires or completes.
 */
export type PendingDevice = {
  provider: LoginProvider;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** RFC 8628's pre-filled URL, when the provider sent one. */
  verificationUriComplete?: string;
  intervalMs: number;
  /** Epoch ms. Past this the grant is dead and a new START is the only way forward. */
  expiresAt: number;
  /** The backend this grant was started against, so a resume can refuse to poll a
   *  different one. Google's grant lives in Convex; asking another deployment about a
   *  code it never issued is a confusing failure rather than an honest restart. */
  deploymentUrl?: string;
  /** The ref the printed link carries, claimed by FINISH once signed in (lib/adClick.ts). */
  clickRef?: string;
};

/**
 * Ask the provider for a code. Returns immediately; nobody waits here.
 *
 * With `siteUrl`, the URL handed back is retasc.com's `/cli-device` stop rather than the
 * provider's page, so the ad click cookie in the human's browser is read on the way.
 */
export async function deviceStart(
  provider: LoginProvider,
  deploymentUrl: string,
  siteUrl?: string,
): Promise<PendingDevice> {
  const ref = siteUrl ? newClickRef() : undefined;
  // The printed link becomes the stop, and the pre-filled URL goes with it: opening the
  // provider directly is what skipped the cookie.
  const throughSite = (pending: PendingDevice): PendingDevice => {
    if (!siteUrl || !ref) return pending;
    const { verificationUriComplete: _direct, ...rest } = pending;
    return { ...rest, verificationUri: deviceLink(siteUrl, provider, ref), clickRef: ref };
  };
  if (provider === "google") {
    const convex = new ConvexHttpClient(deploymentUrl);
    const start = (await convex.action(googleDeviceStart, {})) as {
      userCode: string;
      verificationUrl: string;
      deviceCode: string;
      intervalSeconds: number;
      expiresInSeconds: number;
      verificationUrlComplete?: string;
    };
    return throughSite({
      provider,
      deploymentUrl,
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      verificationUri: start.verificationUrl,
      ...(start.verificationUrlComplete
        ? { verificationUriComplete: start.verificationUrlComplete }
        : {}),
      intervalMs: (start.intervalSeconds || 5) * 1000,
      expiresAt: Date.now() + start.expiresInSeconds * 1000,
    });
  }
  if (!GITHUB_CLIENT_ID) {
    throw new Error(
      "GitHub client id not configured. Set RETASC_GITHUB_CLIENT_ID (the OAuth App's public Client ID).",
    );
  }
  const start: DeviceStart = await postForm(DEVICE_CODE_URL, {
    client_id: GITHUB_CLIENT_ID,
    scope: "read:user user:email",
  });
  if (!start.device_code) {
    // Same rule as `githubDeviceToken`: quote what GitHub WROTE for a person, never the
    // raw payload.
    const said = start.error_description ?? start.error;
    throw new Error(
      `GitHub didn't hand back a sign-in code${said ? `: ${clean(said)}` : "."} ` +
        `Check your connection and try again.`,
    );
  }
  return throughSite({
    provider,
    deploymentUrl,
    deviceCode: start.device_code,
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    ...(start.verification_uri_complete
      ? { verificationUriComplete: start.verification_uri_complete }
      : {}),
    intervalMs: (start.interval || 5) * 1000,
    expiresAt: Date.now() + start.expires_in * 1000,
  });
}

/**
 * Poll an already-started grant for at most `budgetMs`, and sign in if it completed.
 *
 * BOUNDED ON PURPOSE. The caller is an agent, and an agent that blocks for the grant's
 * full fifteen minutes is the very failure this split exists to avoid. `false` means
 * "not yet, ask again" — the human has not clicked — and is not an error. Anything
 * genuinely terminal (denied, expired, a misconfigured client) throws, because those
 * cannot be fixed by asking again and an agent must be told to stop rather than loop.
 */
export async function deviceFinish(
  pending: PendingDevice,
  deploymentUrl: string,
  budgetMs: number,
): Promise<boolean> {
  const convex = new ConvexHttpClient(deploymentUrl);
  let intervalMs = pending.intervalMs || 5000;
  const stopAt = Math.min(Date.now() + budgetMs, pending.expiresAt);
  let upstream: string | undefined;

  while (Date.now() < stopAt) {
    // Never poll SOONER than the provider asked. Clamping the sleep to the remaining
    // budget would do exactly that on the last iteration — and after a `slow_down` that
    // interval is the provider telling us to back off. Stop instead; the caller
    // re-enters on its next invocation anyway.
    const wait = Math.min(intervalMs, Math.max(0, stopAt - Date.now()));
    if (wait < intervalMs) break;
    await sleep(wait);
    if (Date.now() > pending.expiresAt) break;
    if (pending.provider === "google") {
      const r = (await convex.action(googleDevicePoll, { deviceCode: pending.deviceCode })) as
        | { status: "pending" }
        | { status: "slowDown" }
        | { status: "ok"; googleToken: string };
      if (r.status === "ok") {
        upstream = r.googleToken;
        break;
      }
      if (r.status === "slowDown") intervalMs += 5000;
      continue;
    }
    const r = await postForm(TOKEN_URL, {
      client_id: GITHUB_CLIENT_ID,
      device_code: pending.deviceCode,
      grant_type: GRANT,
    });
    if (r.access_token) {
      upstream = r.access_token;
      break;
    }
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`Authorization failed: ${clean(String(r.error_description ?? r.error))}`);
  }

  if (!upstream) {
    if (Date.now() >= pending.expiresAt) {
      throw new Error("The sign-in code expired before it was approved. Start again.");
    }
    return false;
  }

  const res: any = await convex.action(signIn, {
    provider: pending.provider === "google" ? "google-device" : "github-device",
    params: pending.provider === "google" ? { googleToken: upstream } : { githubToken: upstream },
  });
  const tokens = res?.tokens;
  if (!tokens?.token) throw new Error("Sign-in did not return a session token.");
  patchConfig({
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    loginProvider: pending.provider,
  });
  if (pending.clickRef) await claimClickRef(deploymentUrl, tokens.token, pending.clickRef);
  return true;
}

/**
 * Run a device-flow login and persist the resulting Convex Auth session to
 * ~/.retasc/config.json. Prints the user code + verification URL.
 *
 * With no `provider`, asks which door when a human is present and falls back to
 * GitHub when one isn't.
 */
export async function deviceLogin(
  provider?: LoginProvider,
  opts?: {
    /** An agent is driving: no TTY, but a human is in the chat and can click. */
    agentDriven?: boolean;
    /** Called with the approve URL before the wait begins. See browserLogin. */
    onUrl?: (url: string) => void;
    /** Signing in to accept an invite. They join someone else's org, so no ad bought
     *  them and nothing may park a click for them (lib/adClick.ts). */
    invited?: boolean;
  },
): Promise<void> {
  const cfg = loadConfig();

  // RTSC-691 — try the browser round trip FIRST when a human is present.
  //
  // For them it removes the eight characters they had to retype, and skips the
  // which-door question entirely: they pick GitHub, Google or a passkey in the Dash,
  // where they are often already signed in.
  //
  // GATED, and the gate is load-bearing rather than cautious. This path opens a listener
  // and BLOCKS until somebody clicks. Where nobody can click it blocks for the full
  // timeout and then falls through, turning a fast, honest refusal into a long hang — in
  // CI, in a container, and in the CLI's own tests.
  //
  // A TTY check alone is NOT that gate, which is the trap here: `isInteractive()` is TRUE
  // over SSH. On a remote box there is usually no browser to open, `xdg-open` is absent
  // and its failure is swallowed by design, and — decisively — the redirect targets
  // 127.0.0.1 on whichever machine opened the link, so a human clicking on their laptop
  // can never reach a listener on the server. See canOpenBrowser().
  //
  // It does not help an agent-driven `bind` either, which was the original hope. An
  // agent running a blocking command does not see stdout until the process exits, so a
  // URL printed at the top of a five-minute wait reaches nobody. Making cold `bind`
  // agent-runnable needs a two-step shape — print and exit, then complete — which is a
  // different change; see RTSC-678.
  //
  // Naming a provider (`--github` / `--google`) still means the device flow, because
  // that flag is a statement about which upstream identity to use and this path does not
  // take one.
  // RTSC-713 — an agent with no browser door has nowhere to fall to, so say so NOW.
  //
  // Found by the test for this, which hung. The device flow below prints a code to be
  // retyped and then asks which door; both need a TTY, and an agent has neither. Falling
  // through left the process blocked on a prompt nobody could see, which is the worst
  // available outcome: not a refusal an agent can relay, just silence until something
  // times out. SSH, containers and CI all land here, and for all three the honest answer
  // is immediate.
  if (opts?.agentDriven && !canOpenBrowser(true)) {
    throw new Error(
      "no browser available on this machine, and signing in needs one. " +
        "Over SSH or in a container the approve link cannot reach this host: sign in on a " +
        "machine with a browser and bind there, or run `retasc login` yourself at a terminal.",
    );
  }
  if (!provider && canOpenBrowser(opts?.agentDriven)) {
    try {
      await browserLogin(cfg.deploymentUrl, cfg.dashUrl, opts?.onUrl, opts?.invited);
      return;
    } catch (e) {
      // Every failure here is recoverable by the door below, so say what happened and
      // carry on rather than ending a sign-in that can still succeed. A container with
      // no browser is the expected case, not an error.
      const why = e instanceof Error ? e.message : String(e);
      console.error(`Browser sign-in didn't complete (${why}). Falling back to a code.`);
      // RTSC-713 — but an agent has no fallback to fall to. The device flow below prints
      // a code for someone to retype and then asks which door, both of which need a TTY.
      // Continuing would hang until timeout and then fail with a message about a prompt
      // nobody saw. Rethrow so the caller reports SIGN_IN_FAILED, which is honest and
      // immediate, instead of a wait that ends in a lie.
      if (opts?.agentDriven) throw e;
    }
  }

  const door = provider ?? (await chooseProvider({ remembered: cfg.loginProvider }));
  const convex = new ConvexHttpClient(cfg.deploymentUrl);
  const hop: DeviceHop | undefined = opts?.invited ? undefined : { siteUrl: SITE_URL, ref: newClickRef() };

  // Exchange the upstream token for a Retasc (Convex Auth) session. The token is
  // used here and never stored: the session is the only credential that persists.
  const params =
    door === "google"
      ? { googleToken: await googleDeviceToken(convex, hop) }
      : { githubToken: await githubDeviceToken(hop) };

  const res: any = await convex.action(signIn, {
    provider: door === "google" ? "google-device" : "github-device",
    params,
  });
  const tokens = res?.tokens;
  if (!tokens?.token) {
    throw new Error("Sign-in did not return a session token.");
  }

  // Record the door only now, on the far side of a sign-in that actually worked.
  // Written here rather than at the point of choosing so a failed or abandoned
  // attempt can never become next time's default.
  patchConfig({ token: tokens.token, refreshToken: tokens.refreshToken, loginProvider: door });
  if (hop) await claimClickRef(cfg.deploymentUrl, tokens.token, hop.ref);
}

/**
 * Does this thrown error clearly mean "this refresh token can never mint a new
 * session" — as opposed to a transient backend blip? RTSC-178.
 *
 * Note the asymmetry in how Convex Auth's refresh grant fails:
 *   - A genuinely expired/invalid/reused refresh token does NOT throw — the
 *     server returns `{ tokens: null }`, which `refreshSession` already reads as
 *     `false` (no exception reaches here).
 *   - The `catch` only sees *thrown* errors: network failures, 5xx, and the
 *     opaque masked "Server Error" prod returns for any uncaught server-side
 *     throw — all transient — plus the rare corrupt/unparseable stored token
 *     (`parseRefreshToken` throws "Can't parse refresh token …").
 *
 * So we default to "transient" and only classify as unrefreshable when the
 * message is unmistakably refresh-token-shaped. In prod a corrupt-token throw is
 * itself masked to "Server Error" and so reads as transient — the deliberate,
 * safe bias (RTSC-165 saw exactly this masking): never drag a user with a valid
 * session through the whole device flow on a one-off hiccup. A truly dead
 * refresh token still reaches `deviceLogin` via the `{ tokens: null }` → `false`
 * path above, unaffected by this classifier.
 */
export function isUnrefreshableRefreshToken(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return /can'?t parse refresh token|cannot parse refresh token|invalid refresh token|expired refresh token|refresh token (?:is |has )?(?:invalid|expired)/i.test(
    msg,
  );
}

/**
 * Silently mint a fresh access token from the stored refresh token and persist
 * the rotated pair to ~/.retasc/config.json.
 *
 * Convex Auth access tokens (the JWT in `token`) live only ~1h; the refresh
 * token is long-lived (session default ~30d) and exists precisely to swap for a
 * new access token without re-running the device flow. Calling `auth:signIn`
 * with `{ refreshToken }` (no provider/params) is Convex Auth's refresh grant —
 * it returns `{ tokens: { token, refreshToken } }` with BOTH rotated (refresh
 * tokens are single-use; the old one is invalidated), so we must write the new
 * pair back immediately and never reuse the old refresh token.
 *
 * Returns true on success (config now holds a fresh session), false when there
 * is no refresh token or the grant is cleanly rejected (expired/invalid/reused,
 * which the server signals as `{ tokens: null }`) — the caller then falls back
 * to a full `deviceLogin()`. A *transient* failure (network/5xx/opaque backend
 * blip) is RE-THROWN so the caller can surface a retryable error instead of
 * forcing a needless device-flow re-login (RTSC-178). Never prints token values.
 */
export async function refreshSession(): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.refreshToken) return false;
  try {
    const convex = new ConvexHttpClient(cfg.deploymentUrl);
    const res: any = await convex.action(signIn, { refreshToken: cfg.refreshToken });
    const tokens = res?.tokens;
    if (!tokens?.token) return false;
    patchConfig({ token: tokens.token, refreshToken: tokens.refreshToken });
    return true;
  } catch (err) {
    // A clearly refresh-token-shaped rejection means we genuinely cannot
    // refresh — fall through to device login. Anything else (network, 5xx,
    // masked prod "Server Error") is transient: rethrow so `withAuth` surfaces a
    // retryable error rather than dragging a valid session through the device
    // flow at an hourly access-token boundary.
    if (isUnrefreshableRefreshToken(err)) return false;
    throw err;
  }
}
