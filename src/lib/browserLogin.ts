import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";

/**
 * Catch a browser sign-in on a loopback port (RTSC-691).
 *
 * WHAT THIS BUYS, precisely. The device flow prints an eight-character code for a human
 * to retype into a web page and to pick a door (GitHub or Google) in the terminal. This
 * removes both: the browser opens, they click once, and they choose the door in the Dash
 * where they are often already signed in.
 *
 * WHAT IT DOES NOT BUY, despite an earlier draft of this comment saying otherwise: it
 * does NOT make sign-in agent-runnable. It blocks until somebody clicks, and `bind` with
 * no TTY still refuses fast rather than wait. Sign-in without a human at all needs a
 * two-step print-and-exit shape, which is not this and is tracked on RTSC-678. See
 * `canOpenBrowser()` in auth.ts for the conditions this door is offered under.
 *
 * This is the standard native-app pattern (`gh auth login --web`, `vercel login`), and
 * the properties that make it safe live mostly on the server — see `convex/cliAuth.ts`.
 * What this side owns:
 *
 *   • **127.0.0.1, never 0.0.0.0.** Bound to the loopback interface explicitly, so the
 *     listener is not reachable from the network even for the seconds it exists.
 *   • **A `state` nonce we generate and verify.** The code is bound to it server-side,
 *     so a redirect that did not originate from this process is rejected here and the
 *     code is never sent on to be exchanged.
 *   • **One shot, then closed.** The server stops on the first VERIFIED callback, or on
 *     the timeout. An unverified hit (no code, or a nonce that does not match) is
 *     answered and IGNORED rather than fatal, so a stray request cannot knock out a
 *     sign-in the real redirect is still on its way to complete.
 *
 * DELIBERATELY NOT THE ONLY DOOR. There is no browser inside a container, and over SSH
 * the redirect could not reach this listener even if there were — it targets 127.0.0.1 on
 * whichever machine opened the link. Both are exactly where `bind` often runs, so the
 * device flow stays and `canOpenBrowser()` in auth.ts decides between them BEFORE this is
 * started. Losing the ability to sign in over SSH would be a far worse regression than the
 * eight characters this saves.
 */

/** The caller already holds the port it opened, so only the code travels back. */
export type BrowserLoginResult = { code: string };

/** How long to wait for the human to click Approve. Generous: they may have to sign in
 *  to the Dash first, and possibly through GitHub or Google after that. */
const WAIT_MS = 5 * 60 * 1000;

/**
 * Open a loopback listener and return the URL to send the browser to, plus a promise
 * that resolves when the browser comes back.
 *
 * Split in two on purpose. The caller needs the URL BEFORE the wait starts, so it can
 * print it — a printed URL is what makes this work when the browser fails to open, which
 * is the common case on a headless Linux box where `xdg-open` is absent.
 */
export async function startBrowserLogin(dashUrl: string, opts?: { invited?: boolean }): Promise<{
  url: string;
  port: number;
  wait: () => Promise<BrowserLoginResult>;
  cancel: () => void;
}> {
  const state = randomBytes(24).toString("hex");

  let resolve!: (r: BrowserLoginResult) => void;
  let reject!: (e: Error) => void;
  const settled = new Promise<BrowserLoginResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The timeout below rejects this promise whether or not anyone is awaiting it. A caller
  // that takes `url`/`cancel` and never calls `wait()` would otherwise get an unhandled
  // rejection, which is fatal on Node 15+. Attaching an inert handler at construction
  // makes the promise safe to ignore; `wait()` still sees the real rejection.
  settled.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");

    // The browser is a person's, so answer it in a way a person can read. Whatever
    // happens here, the tab is finished with.
    const reply = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Retasc</title>` +
          `<body style="font:16px system-ui;padding:3rem;max-width:32rem;margin:auto">${body}</body>`,
      );
    };

    if (!code || gotState !== state) {
      // A mismatched nonce means this redirect did not come from the flow we started.
      // The code is not forwarded, so it expires unspent two minutes later.
      reply(400, "<h1>Sign-in could not be verified</h1><p>Close this tab and run <code>retasc login</code> again.</p>");
      return;
    }
    reply(200, "<h1>Signed in</h1><p>You can close this tab and go back to your terminal.</p>");
    resolve({ code });
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    // Port 0: the OS picks a free one. Hard-coding a port would collide with a second
    // `retasc login` and with whatever else the developer is running.
    server.listen(0, "127.0.0.1", res);
  });

  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => {
    reject(new Error(`TIMEOUT: no response from the browser within ${WAIT_MS / 60_000} minutes`));
  }, WAIT_MS);
  // Do not hold the process open on this timer alone.
  timer.unref?.();

  const close = () => {
    clearTimeout(timer);
    // `close()` stops accepting but leaves the browser's idle keep-alive socket open, and
    // that handle holds the event loop until Node's 5s keepAliveTimeout fires — so the
    // CLI would appear to hang for five seconds after a successful sign-in.
    server.closeAllConnections?.();
    server.close();
  };

  return {
    // `join=1` tells the page this sign-in is for an invite, so it parks no ad click
    // (cli/src/lib/adClick.ts).
    url:
      `${dashUrl.replace(/\/+$/, "")}/cli-auth?port=${port}&state=${encodeURIComponent(state)}` +
      (opts?.invited ? "&join=1" : ""),
    port,
    wait: async () => {
      try {
        return await settled;
      } finally {
        close();
      }
    },
    cancel: close,
  };
}
