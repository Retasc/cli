import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/**
 * The CLI's half of matching a signup to the ad that brought it (convex/lib/adClick.ts).
 *
 * An ad click lands on retasc.com as a cookie, and the CLI creates the org with no
 * browser behind the call, so on its own the CLI can never say which ad bought it. Two
 * things here let the backend find out anyway:
 *
 *   • **A code sign-in's link goes through retasc.com/cli-device.** The person opens it
 *     in the browser they actually use, which is the one holding the cookie. The landing
 *     site's edge script redirects them straight on to GitHub's or Google's code page,
 *     so they see no page of ours, and on the way it parks the cookie (or their address)
 *     under a random ref. Once signed in, the CLI claims the ref.
 *   • **`createOrg` carries this machine's public address**, for the match against
 *     recent ad clicks when no page saw a cookie (an earlier session, so no sign-in page
 *     at all).
 *
 * Every call here is best effort. Attribution must never slow a sign-in down by more
 * than a moment or fail it, so each one is bounded and swallows its errors.
 */

const claimDeviceRef = makeFunctionReference<"mutation">("adClicks:claimDeviceRef");

/** retasc.com, whose edge script answers the code sign-in's link (web/_worker.js). */
export const SITE_URL = process.env.RETASC_SITE_URL ?? "https://retasc.com";

/** 16 random bytes, base64url: unguessable, and inside the backend's `validRef`. */
export function newClickRef(): string {
  return randomBytes(16).toString("base64url");
}

/** The link a code sign-in prints and opens, in place of the provider's own page. */
export function deviceLink(siteUrl: string, provider: "github" | "google", ref: string): string {
  const url = new URL("/cli-device", siteUrl);
  url.searchParams.set("r", ref);
  url.searchParams.set("to", provider);
  return url.toString();
}

/** Collect what the link's page parked, now that this process holds a session. */
export async function claimClickRef(deploymentUrl: string, token: string, ref: string): Promise<void> {
  try {
    const convex = new ConvexHttpClient(deploymentUrl);
    convex.setAuth(token);
    await convex.mutation(claimDeviceRef, { ref });
  } catch {
    // An older backend without the function, or a network blip. The org still gets the
    // address match and the hashed email.
  }
}

/**
 * This machine's public address as Cloudflare sees it, or null. Read from retasc.com's
 * `/cdn-cgi/trace`, the same view of a client the landing site records a click with.
 * The landing records both address families, so whichever one this process reaches
 * the internet over (IPv4 from a container without IPv6, say) is on file.
 */
export async function publicIp(siteUrl: string = SITE_URL, timeoutMs = 1000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/cdn-cgi/trace", siteUrl), { signal: ctl.signal });
    if (!res.ok) return null;
    return /^ip=([0-9a-fA-F:.]{2,45})$/m.exec(await res.text())?.[1] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
