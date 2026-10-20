// RTSC-492 — turn whatever the person was handed into the code the server matches.
//
// An invite reaches someone as a LINK (`https://dash.retasc.com/join#rtscinv_…`), and a
// link is what they paste. `acceptInvite` matches an exact string, and it should stay that
// way: normalising a paste is a property of the edge that accepts typed input, not of the
// mutation that grants membership. So the unwrapping happens here.

/** Every invite code the product has ever minted starts with this. */
const INVITE_PREFIX = "rtscinv_";

/**
 * The invite code inside a link, a bare code, or a code someone pasted with prose
 * around it.
 *
 * One rule rather than a parser: find the first token that LOOKS like an invite code,
 * anywhere in the input. That covers the fragment (`…/join#rtscinv_x`), a query string
 * (`?code=rtscinv_x`), a path segment, an email client's `<…>` wrapper and a trailing
 * period from a sentence, without needing to know which of those the sender used — and
 * without the URL-shape guessing that gets one of them wrong.
 *
 * A token that isn't our shape is still passed through UNCHANGED as long as it can't be a
 * link. A future code format then keeps working with no CLI release, and the server's
 * "That invite code isn't recognized" stays the authority on what's valid. Something
 * link-shaped with no code in it is the one case we refuse locally, because forwarding a
 * URL as a code can only ever produce that same message with none of the diagnosis.
 */
export function parseInviteCode(input: string): string {
  const raw = String(input ?? "").trim();
  // Hex today, but accept the wider token charset a future format might use rather than
  // pinning this to `[0-9a-f]{48}` and having to ship a release to read a new code.
  const match = raw.match(new RegExp(`${INVITE_PREFIX}[A-Za-z0-9_-]+`));
  if (match) return match[0];

  const bare = raw.replace(/^[<"'(]+|[>"'.,)]+$/g, "");
  if (bare && !/[\s/:]/.test(bare)) return bare;

  throw new Error(
    raw
      ? "That doesn't contain an invite code. Paste the whole invite link, or just the `rtscinv_…` code."
      : "No invite code given. Pass the invite link, or just the `rtscinv_…` code.",
  );
}
