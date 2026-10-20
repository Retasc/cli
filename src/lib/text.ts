/**
 * Strip control characters from a string before printing it (RTSC-261, RTSC-492).
 *
 * Anything that came off the wire is untrusted output: it reaches `console.log` in a
 * terminal that acts on escape sequences, so a value carrying `\x1b[…` can move the cursor,
 * clear the line, or overwrite text the user is reading. That matters most where the text
 * sits next to a decision — a name in a confirm prompt could be dressed up to look like the
 * prompt itself.
 *
 * The riskiest strings in the product are the ones this exists for: an imported member's
 * display name is chosen in ClickUp/Jira/Asana by someone who is not our user, carried
 * across by a migration verbatim, and then shown to a human about to make an irreversible
 * choice about it.
 *
 * Mirrors `sanitize` in `convex/lib/userError.ts` and the inline cleanup in `formatError`.
 * The three are one rule; this is the copy the CLI's own printing paths share.
 */
export function clean(s: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, " ");
}
