import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// The terminal-input primitives, extracted from commands/bind.ts (RTSC-508).
//
// They moved because `auth.ts` needs to ask a question too — which door to sign
// in through — and importing it from `commands/bind.ts` would close a cycle:
// bind already imports `deviceLogin` from auth. Duplicating `ask` instead would
// have meant duplicating the EOF race fix below, which is exactly the kind of
// thing that gets fixed once and then silently rots in the copy.
//
// `commands/bind.ts` re-exports all three, so every existing call site is
// unchanged.

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // readline's question() NEVER settles when stdin hits EOF (Ctrl-D, or a
    // closed pipe) — it silently drops the callback rather than resolving ""
    // or throwing, so a bare `await` here wedges the CLI with no output and no
    // exit. Race the close event so callers fail fast instead (RTSC-269).
    const closed = new Promise<never>((_, reject) =>
      rl.once("close", () => reject(new Error("input closed"))),
    );
    closed.catch(() => {}); // the normal path closes rl too; that loser rejection is expected
    return (await Promise.race([rl.question(question), closed])).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, assumeYes?: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!isInteractive()) return false;
  const a = (await ask(`${question} [y/N] `)).toLowerCase();
  return a === "y" || a === "yes";
}

/**
 * One option in a numbered pick list.
 *
 * `note` is one line of help under the label, for the case where the name alone does
 * not settle it ("API key (pay as you go)").
 */
export type Choice = { id: string; label: string; note?: string | null };

/**
 * Ask a human to PICK, by number, never to type a name (RTSC-901).
 *
 * Typing is how a plan called "Max 20x" gets recorded as "max20", "Max20x" and
 * "MAX 20X" across three machines and then fails to group. Numbers make the common
 * answer mechanical and leave typing for the case that genuinely needs it, which is
 * an option this list does not have.
 *
 * Returns the chosen `id`, or `null` when there is nobody to ask: a non-interactive
 * run SKIPS the question rather than blocking a script or guessing an answer. A
 * question nobody answered has to stay unanswered — that is the difference between
 * "not asked" and a wrong fact recorded forever.
 *
 * Enter alone takes `defaultId` when one is given, so the common path is one keypress.
 */
export async function select(
  question: string,
  choices: Choice[],
  defaultId?: string,
): Promise<string | null> {
  if (!isInteractive() || choices.length === 0) return null;
  stdout.write(`${question}\n`);
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    const mark = c.id === defaultId ? " (default)" : "";
    stdout.write(`  ${String(i + 1).padStart(2)}. ${c.label}${mark}\n`);
    if (c.note) stdout.write(`      ${c.note}\n`);
  }
  // Three tries, then give up rather than loop at someone. A person who has typed
  // nonsense three times is not going to type a number on the fourth, and a CLI that
  // will not let go of the terminal is worse than an unanswered question.
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask(defaultId ? `Number [${choices.findIndex((c) => c.id === defaultId) + 1}]: ` : "Number: ");
    if (!raw && defaultId) return defaultId;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].id;
    stdout.write(`  Pick a number between 1 and ${choices.length}.\n`);
  }
  return null;
}
