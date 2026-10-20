import { clean } from "./text.js";

// RTSC-673 — the receipt a finished `bind` prints.
//
// It replaces a tail that ended on fourteen lines of MCP config plus a note reading
// "(Claude Code CLI not detected)". Both were wrong at the moment they were read: the
// JSON told someone to paste a block we had just written to disk for them, and the note
// announced a detection miss on a screen whose whole content is that everything worked.
// Between them they buried the one thing a new owner needed, which is what to do next.
//
// A box rather than a list because this is a RECEIPT: bounded, glanced at once,
// confirming the four facts someone might reasonably doubt (which org, which project,
// where the secret went, what got written into their repo). The call to action stays
// OUTSIDE it, so the thing to act on is not one more row to scan past.

/** Inner width. 62 + borders fits an 80-column terminal with room to spare. */
const W = 62;

/**
 * Does this terminal render box-drawing characters and `…` reliably?
 *
 * Windows `cmd.exe` is the one that does not, and it is the same distinction
 * `lib/launcher.ts` already draws for spawning. A garbled box is worse than a plain
 * one: it reads as corruption at the exact moment we are telling someone everything
 * worked.
 */
const FANCY = process.platform !== "win32";

const B = FANCY
  ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ml: "├", mr: "┤", dot: "·", ell: "…" }
  : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", ml: "+", mr: "+", dot: "-", ell: "..." };

/**
 * Fit `s` to `n` columns, ellipsing rather than letting it blow the box open.
 *
 * Truncation, not padding alone: an org can be named anything, and a name one character
 * over the width turns every following line into a ragged edge. Padding is the easy half
 * and the half that looks fine in testing, because test fixtures are short.
 */
function fit(s: string, n: number): string {
  const t = clean(s);
  if (t.length <= n) return t.padEnd(n);
  return t.slice(0, Math.max(0, n - B.ell.length)) + B.ell;
}

export type CardRow = { label: string; value: string; note?: string };

/** One bordered card: a title line, labelled rows, then a footer line. */
export function card(title: string, rows: CardRow[], footer?: string): string {
  const inner = W - 2; // one space of padding each side
  const line = (s: string) => `${B.v} ${fit(s, inner)} ${B.v}`;
  const rule = (l: string, r: string) => `${l}${B.h.repeat(W)}${r}`;

  const LABEL = 12;
  const VALUE = 20;
  const out = [rule(B.tl, B.tr), line(title), rule(B.ml, B.mr)];
  for (const r of rows) {
    // A note sits in a third column, so the values stay in one scannable rail. Without a
    // note the value simply runs on — padding it anyway would leave a trench of spaces
    // in the middle of the card.
    //
    // The value is fitted one column NARROWER than its rail so a gutter always survives.
    // `fit` pads to exactly VALUE, so a value of exactly that width, or one ellipsed to
    // it, butted straight against the note: `~/.codex/config.tomlupdated`. It read as a
    // corrupted path in the one surface whose job is to say calmly that this worked
    // (RTSC-793 — RTSC-780's three rows all happened to be shorter).
    const body = r.note
      ? `${fit(r.label, LABEL)}${fit(r.value, VALUE - 1)} ${r.note}`
      : `${fit(r.label, LABEL)}${r.value}`;
    out.push(line(body));
  }
  if (footer) {
    out.push(rule(B.ml, B.mr));
    out.push(line(footer));
  }
  out.push(rule(B.bl, B.br));
  return out.join("\n");
}

/** The `·` the CLI already uses between a prefix and its name, ASCII-safe. */
export const DOT = B.dot;
