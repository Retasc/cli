import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { api, cliError, formatError } from "../api.js";
import { clean } from "../lib/text.js";
import { ask, confirm, isInteractive } from "../lib/prompt.js";
import { pickExisting } from "./bind.js";

// RTSC-524 — bring another tracker across, from the terminal.
//
// The terminal track could do everything except this. To import from Linear, Jira, Asana,
// ClickUp or Shortcut you had to stop, open a browser and finish in the Dash — the one step
// that broke "start in a terminal, finish in a terminal".
//
// The backend was already here and needed nothing: `listImportSources`,
// `listImportTargets`, `listImportStatuses` and `runImport` are owner-gated Convex functions
// authenticated by a USER SESSION, which is exactly what the CLI holds after `retasc login`.
// `cli/src/api.ts` simply never referenced them.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not guess the status mapping. A source lets
// its users name their own columns, so the only honest way to know what one means is to ask
// — that decision is recorded in `convex/lib/importAdapter.ts`, which deleted the
// name-based heuristics after a `Rejected` column imported live work as `canceled`, out of
// dispatch, with no error anywhere. A one-shot `retasc import --source jira --target ENG`
// that inferred the mapping would not be this feature; it would be the feature that was
// removed, wearing a CLI.

/** What `listImportSources` hands back. */
type Source = {
  source: string;
  label: string;
  targetNoun: string;
  authFields: Array<{ key: string; label: string; hint?: string; secret?: boolean }>;
  supportsStatusMapping?: boolean;
};

type Target = { id: string; key: string; name: string };

type SourceStatus = {
  id: string;
  name: string;
  suggested: string;
  order: number;
  group: "not_started" | "active" | "done" | "closed";
};

type Member = { id: string; name: string };

/** The five destinations a column can be mapped to. Mirrors `MappedStatus`. */
const MAPPED = ["todo", "doing", "review", "done", "canceled"] as const;

/**
 * The source's own section names, so the list reads as the shape the human already knows
 * from their tool. Mirrors `GROUP_LABEL` in `dash/src/lib/statusMapping.ts` (RTSC-436).
 */
const GROUP_LABEL: Record<SourceStatus["group"], string> = {
  not_started: "Not started",
  active: "Active",
  done: "Done",
  closed: "Closed",
};

/** Section order, matching the Dash. */
const GROUP_ORDER: Array<SourceStatus["group"]> = ["not_started", "active", "done", "closed"];

/** `YYYY-MM-DD` in the local zone. Mirrored in `dash/src/lib/importGating.ts`. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * What to say before a SECOND import into the same org (RTSC-526).
 *
 * Not a formality. `convex/importWrite.ts` upserts by `sourceIssueId` and patches the match,
 * so a re-import does not duplicate — the identifier and number survive even a rename — but
 * it DOES replace status, labels, title and body with whatever the source says now. Two
 * weeks of moving issues along in Retasc snap back to the source's version.
 *
 * Read from `importHistory`, NOT `latestImport`. The latter is live progress and is swept
 * after 24h, so gating on it means the warning stops firing for exactly the person most at
 * risk: the one who imported last week and has been working in Retasc since.
 *
 * Null when this source has never been imported, so a first run says nothing.
 */
export function reimportWarning(
  history: Array<{ source: string; lastImportedAt?: number | null }>,
  source: string,
  label: string,
): string | null {
  const prior = history.find((h) => h.source === source);
  if (!prior) return null;
  // The reader's day, not UTC (RTSC-527). `toISOString().slice(0, 10)` was the original
  // and it misdates by one: at UTC+7 an import made before 07:00 local prints as
  // yesterday, which is the opposite of useful for a line whose whole job is "how long
  // ago". The Dash's `importDay` formats identically, so one import still gets one date.
  const when = prior.lastImportedAt ? ` (last on ${localDay(new Date(prior.lastImportedAt))})` : "";
  return (
    `\n! You've imported from ${clean(label)} into this org before${when}.\n` +
    `  Re-importing re-syncs those issues, so any edits you made in Retasc to them\n` +
    `  (status, labels, and so on) will be replaced by ${clean(label)}'s version.`
  );
}

/**
 * What each field of the server's `ImportSummary` is CALLED, for a person.
 *
 * The summary is a wire payload, and it used to be printed with its own keys as labels —
 * `issuesCreated`, `commentsInserted`, `attachmentsRehosted`, one per line. That is a JSON
 * object with the braces taken off: it reads as the inside of the program rather than as
 * the answer to "what just came across". The names live here, in one list, next to the
 * shape they describe (`ImportSummary` in convex/import.ts).
 */
const SUMMARY_LABELS: Record<string, string> = {
  totalIssues: "Issues seen",
  issuesCreated: "Issues created",
  issuesUpdated: "Issues updated",
  relationsAdded: "Links between issues",
  commentsInserted: "Comments",
  attachmentsRehosted: "Attachments copied",
  attachmentsFailed: "Attachments that failed",
};

/**
 * A label for a field the list above doesn't name.
 *
 * A field this CLI is too old to know about must still read as English rather than as a
 * key, because the pairing is permanent: the backend deploys separately, so there is
 * always a version of this CLI that predates the newest summary field. `fooBarBaz`
 * becomes "Foo bar baz" — not the real name someone would have chosen, but a phrase.
 */
export function summaryLabel(key: string): string {
  // `hasOwnProperty`, not a bare lookup. The keys come off the wire, and a bare
  // `SUMMARY_LABELS[key]` walks Object.prototype: a field named `constructor` or
  // `toString` returns a FUNCTION, which `padEnd` then throws on. That would crash
  // `retasc import` on the line after a multi-minute run finished successfully.
  if (Object.prototype.hasOwnProperty.call(SUMMARY_LABELS, key)) return SUMMARY_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The summary after a run, with the one field that needs words rather than a number.
 *
 * `unmappedStatuses` holds columns that appeared BETWEEN the mapping being set and the run;
 * their issues landed in `todo`. As a count it is a silent slice of work in the wrong place,
 * which is the whole reason the Dash names them.
 */
export function summaryLines(
  summary: Record<string, unknown> | null | undefined,
  label: string,
): string[] {
  const out: string[] = [];
  const unmapped: string[] = [];
  for (const [k, v] of Object.entries(summary ?? {})) {
    if (k === "unmappedStatuses") {
      if (Array.isArray(v)) unmapped.push(...v.map(String));
      continue;
    }
    // Only numbers and strings are printed, which is also what keeps a structured field
    // (`sample`, `relationCyclesSkipped`) from arriving as `[object Object]`.
    if (typeof v === "number" || typeof v === "string") {
      out.push(`  ${summaryLabel(k).padEnd(24)}${clean(v)}`);
    }
  }
  if (unmapped.length) {
    out.push(
      "",
      `! These ${clean(label)} statuses weren't mapped, so their issues landed in todo:`,
      `    ${unmapped.map((u) => clean(u)).join(", ")}`,
      "  They appeared after you set the mapping. Re-import to place them.",
    );
  }
  return out;
}

// --- the progress bar --------------------------------------------------------

/** Lime, in 256-colour. Bright enough to read on both a light and a dark terminal. */
const LIME = "\x1b[38;5;154m";
const DIM = "\x1b[38;5;240m";
const RESET = "\x1b[0m";

/**
 * An indeterminate sweep, for the stretch before the server reports counts (RTSC-528).
 *
 * Pure and frame-indexed rather than time-based, so a test can pin every frame. A block
 * that travels is the honest shape when the total is unknown: a 0% bar reads as stalled,
 * which is the very impression this is here to prevent.
 */
export function sweep(frame: number, width = 24, color = true): string {
  const pos = frame % (width * 2 - 2);
  const at = pos < width ? pos : width * 2 - 2 - pos; // bounce, so it never jumps
  const cells = Array.from({ length: width }, (_, i) =>
    Math.abs(i - at) <= 1 ? "\u2588" : "\u2591",
  ).join("");
  return `  ${color ? LIME : ""}${cells}${color ? RESET : ""}  working…`;
}

/**
 * One line of progress bar.
 *
 * Pure, so the shape can be tested without a terminal. Colour is opt-out via `color`, which
 * the caller ties to a TTY and to `NO_COLOR` — a bar full of escape sequences in a piped log
 * is worse than no bar.
 */
export function progressBar(
  done: number,
  total: number | null,
  width = 24,
  color = true,
): string {
  const known = typeof total === "number" && total > 0;
  // Clamp: a server that reports more done than total must not print a bar wider than the
  // terminal, or a negative one.
  const frac = known ? Math.max(0, Math.min(1, done / total!)) : 0;
  const filled = Math.round(frac * width);
  const bar = known
    ? `${color ? LIME : ""}${"█".repeat(filled)}${color ? DIM : ""}${"░".repeat(width - filled)}${color ? RESET : ""}`
    : `${color ? DIM : ""}${"░".repeat(width)}${color ? RESET : ""}`;
  const count = known ? `${Math.round(frac * 100)}%  ${done}/${total}` : `${done} so far`;
  return `  ${bar}  ${count}`;
}

/**
 * May this column be mapped to `review`?
 *
 * Mirrors `reviewAllowedForGroup` in `convex/lib/importAdapter.ts`, and the reasoning is
 * the server's: `review` means the work is FINISHED and waiting for someone to accept it,
 * and it is non-terminal, so it keeps blocking dependents. Routing a not-yet-started column
 * there manufactures review issues with nothing to review, each jamming whatever depends on
 * it. Offering an option the server will reject is worse than not offering it.
 */
export function reviewAllowed(group: SourceStatus["group"]): boolean {
  return group === "active" || group === "done";
}

/** Read a secret without echoing it, so a token never lands in scrollback. */
async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) return await ask(question);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // readline has no built-in masking, so suppress the echo ourselves and restore it in
  // `finally` — a thrown error mid-prompt must not leave the terminal silent.
  const out = stdout as unknown as { write: (c: string) => boolean };
  const real = out.write.bind(out);
  try {
    const answer = rl.question(question);
    out.write = (chunk: string) => (chunk.includes("\n") ? real(chunk) : true);
    const value = await answer;
    return value.trim();
  } finally {
    out.write = real;
    rl.close();
    real("\n");
  }
}

/**
 * Collect the source's credentials.
 *
 * NEVER from an argument. A token passed as `--token …` lands in shell history, in `ps`
 * output, and in any transcript of the session. Secret fields are read with echo off; an
 * env var (`RETASC_IMPORT_<KEY>`) covers the scripted case without either problem.
 */
async function collectAuth(src: Source): Promise<Record<string, string>> {
  const auth: Record<string, string> = {};
  for (const f of src.authFields) {
    const envKey = `RETASC_IMPORT_${f.key.toUpperCase()}`;
    const fromEnv = process.env[envKey];
    if (fromEnv) {
      console.log(`  ${clean(f.label)}: taken from ${envKey}`);
      auth[f.key] = fromEnv;
      continue;
    }
    if (!isInteractive()) {
      cliError(
        "MISSING_AUTH",
        `${clean(src.label)} needs ${clean(f.label)}, and there is no terminal to ask on.`,
        `Set ${envKey} and run again.`,
      );
    }
    if (f.hint) console.log(`  ${clean(f.hint)}`);
    const value = f.secret
      ? await askSecret(`  ${clean(f.label)} (hidden): `)
      : await ask(`  ${clean(f.label)}: `);
    if (!value) cliError("MISSING_AUTH", `${clean(f.label)} is required.`);
    auth[f.key] = value;
  }
  return auth;
}

/**
 * Walk every column and record what it means. The heart of the command.
 *
 * Each row arrives with a `suggested` value derived server-side from the source's own
 * STRUCTURAL type, never from the column's name, so pressing Enter through the list is a
 * defensible mapping rather than a guess. This is a review-and-correct surface, exactly as
 * the Dash panel is.
 */
export async function mapStatuses(
  statuses: SourceStatus[],
  reviewers: Member[],
  askFn: (q: string) => Promise<string>,
): Promise<{ statusMap: Record<string, string>; reviewerByStatus: Record<string, string> }> {
  const statusMap: Record<string, string> = {};
  const reviewerByStatus: Record<string, string> = {};

  console.log(
    `\nWhat does each column mean? ${statuses.length} to confirm.\n` +
      "  Press Enter to take the suggested answer, or pick another number.\n" +
      "  The suggestion comes from the column's type in your tool, not its name.",
  );

  // Grouped under the source's own section names, in the source's own order within each
  // (RTSC-436/526). On a twenty-column Jira board a flat list is a wall; the sections are
  // the shape the human already has in front of them in their tool.
  const ordered = GROUP_ORDER.flatMap((g) => {
    const rows = statuses.filter((s) => s.group === g).sort((a, b) => a.order - b.order);
    return rows.map((s, i) => ({ s, heading: i === 0 ? GROUP_LABEL[g] : null }));
  });

  for (const { s, heading } of ordered) {
    if (heading) console.log(`\n  ${heading}`);
    const allowed = MAPPED.filter(
      (m) => m !== "review" || (reviewAllowed(s.group) && reviewers.length > 0),
    );
    const suggested = allowed.includes(s.suggested as (typeof MAPPED)[number])
      ? s.suggested
      : "todo";

    // RTSC-529 — NUMBERED, like every other prompt in the CLI.
    //
    // This was the only one that asked you to type a word. Org, project, source, list,
    // reviewer, sign-in door (RTSC-508) and install choice (RTSC-523) are all numbered
    // pickers reading "Choose a number" — and the reviewer picker appears two lines below
    // THIS one, so a single run taught two input styles within four lines of output.
    //
    // RTSC-528 tried to fix that by making the typing instruction explicit. That treated
    // the symptom: a prompt that has to teach you its own input method is usually the
    // wrong input method.
    //
    // The default is marked in the list rather than described outside it, and the words
    // are still accepted — someone ten columns in knows the vocabulary, and typing `doing`
    // beats re-reading a list. That is a shortcut, not the advertised path, so it is not
    // in the instruction.
    console.log(`\n  ${clean(s.name)}`);
    allowed.forEach((m, i) =>
      console.log(`    ${i + 1}) ${m}${m === suggested ? "   (suggested)" : ""}`),
    );
    const defaultSlot = allowed.indexOf(suggested as (typeof MAPPED)[number]) + 1;

    for (let attempt = 0; ; attempt++) {
      const answer = (await askFn(`  Choose a number [${defaultSlot}]: `)).trim().toLowerCase();
      // Enter takes the suggestion; a digit picks a row; a word still works.
      const byNumber = /^\d+$/.test(answer) ? allowed[Number(answer) - 1] : undefined;
      const choice = answer === "" ? suggested : (byNumber ?? answer);
      if (choice && allowed.includes(choice as (typeof MAPPED)[number])) {
        statusMap[s.id] = choice;
        break;
      }
      // Say WHY when the answer names something real but not permitted here. The server
      // would reject it anyway, and repeating the list explains nothing.
      if (answer === "review" && !reviewAllowed(s.group)) {
        console.log("    Not for this column: review means finished and awaiting acceptance,");
        console.log("    and this one holds work nobody has started.");
      } else if (answer === "review") {
        console.log("    No one in this org can be a reviewer yet, so review isn't available.");
      } else {
        console.log(`    Enter a number between 1 and ${allowed.length}.`);
      }
      if (attempt >= 2) throw new Error("no valid choice — aborting");
    }

    // A review column needs a named reviewer, per column rather than per run: two
    // "awaiting acceptance" columns can legitimately belong to different people.
    if (statusMap[s.id] === "review") {
      const who = await pickExisting(
        `    Who reviews "${clean(s.name)}"?`,
        reviewers,
        (m) => clean(m.name),
        askFn,
      );
      reviewerByStatus[s.id] = who.id;
    }
  }
  return { statusMap, reviewerByStatus };
}

/**
 * Poll `latestImport` and redraw one line until told to stop. Returns the stopper.
 *
 * One LINE, rewritten in place, rather than a scrolling log: the interesting number is the
 * current one. Silent without a TTY — a progress bar in a piped log is noise, and the
 * escape codes would end up in whatever reads it.
 *
 * Every failure here is swallowed. This is decoration on top of a run that is happening
 * server-side regardless; a hiccup in the progress query must never be what surfaces as an
 * import failure.
 */
function followProgress(orgId: string): () => void {
  if (!stdout.isTTY) return () => {};
  const color = !process.env.NO_COLOR;
  let stopped = false;
  let frame = 0;
  // Declared before the paint timer that reads it. Safe either way (the callback fires
  // after this line runs), but reading a variable above its declaration is a trap to leave
  // for the next person.
  let latest: { done: number; total: number | null } | null = null;

  // RTSC-528 — DRAW IMMEDIATELY, and keep drawing, rather than waiting to observe
  // `status === "running"`.
  //
  // The first live run showed nothing at all: a 15-issue import is over in a couple of
  // seconds, so the first poll landed before `runImport` had created the row and the second
  // landed after it finished. `running` was never seen, so nothing was ever drawn — and the
  // silent gap this exists to remove was exactly what the human got. A bar that only works
  // on slow imports is a bar nobody sees while testing.
  //
  // So the render loop is independent of the data: it ticks on its own, showing an
  // indeterminate sweep until counts arrive and the real bar once they do.
  const draw = (done: number | null, total: number | null) => {
    stdout.write(`\r\x1b[2K${done === null ? sweep(frame++, 24, color) : progressBar(done, total, 24, color)}`);
  };
  draw(null, null);
  const paint = setInterval(() => {
    if (!stopped && latest === null) draw(null, null);
  }, 120);

  // Counts, whenever the server has them. Every failure is swallowed: this is decoration
  // on a run happening regardless, and must never be what surfaces as an import failure.
  const poll = async () => {
    while (!stopped) {
      try {
        const p = (await api.latestImport({ orgId })) as {
          status?: string;
          issuesDone?: number;
          issuesTotal?: number | null;
        } | null;
        if (!stopped && p && p.status === "running") {
          latest = { done: p.issuesDone ?? 0, total: p.issuesTotal ?? null };
          draw(latest.done, latest.total);
        }
      } catch {
        /* progress never speaks for the run */
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  };
  void poll();

  return () => {
    stopped = true;
    clearInterval(paint);
    // Clear the line so the summary never lands on a half-drawn bar.
    stdout.write("\r\x1b[2K");
  };
}

export type ImportOpts = { orgId?: string; source?: string; yes?: boolean };

/**
 * The whole import, from source to finished run, returning the project it landed in.
 *
 * RTSC-530 — split out of `importAction` so `retasc bind` can offer "bring your tracker
 * across" as one of the ways a FIRST project comes into existence, the way the Dash's
 * project step does. It calls this; it does not resemble it. Two copies of the auth prompt,
 * target picker and column mapping is how the two drift, and the mapping is the part that
 * decides where a whole backlog lands.
 *
 * Returns null when the human declines at the confirmation, so the caller can fall back
 * rather than treat a deliberate "no" as a failure.
 */
export async function runImportFlow(opts: {
  orgId: string;
  orgLabel: string;
  source?: string;
  yes?: boolean;
}): Promise<{ projectId: string; prefix?: string } | null> {
  const { orgId, orgLabel } = opts;

  // --- which tracker --------------------------------------------------------

  // --- which tracker --------------------------------------------------------
  const sources = (await api.listImportSources()) as Source[];
  if (!sources.length) cliError("NO_SOURCES", "No import sources are available.");
  const src = opts.source
    ? sources.find((s) => s.source === opts.source) ??
      cliError(
        "UNKNOWN_SOURCE",
        `There's no import source called "${clean(opts.source)}".`,
        `Try one of: ${sources.map((s) => s.source).join(", ")}`,
      )
    : await pickExisting("Bring work across from", sources, (s) => clean(s.label));

  // --- credentials ----------------------------------------------------------
  console.log(`\nConnect to ${clean(src.label)}:`);
  const auth = await collectAuth(src);

  // --- which team/project/workspace -----------------------------------------
  const { targets } = (await api.listImportTargets({ orgId, source: src.source, auth })) as {
    targets: Target[];
  };
  if (!targets.length) {
    cliError(
      "NO_TARGETS",
      `That ${clean(src.label)} account has no ${clean(src.targetNoun)} we can import.`,
      "Check the credentials belong to the right account.",
    );
  }
  const target =
    targets.length === 1
      ? targets[0]
      : await pickExisting(
          `Which ${clean(src.targetNoun)}`,
          targets,
          (t) => `${clean(t.name)} (${clean(t.key)})`,
        );

  // --- what each column means ------------------------------------------------
  let statusMap: Record<string, string> | undefined;
  let reviewerByStatus: Record<string, string> | undefined;
  if (src.supportsStatusMapping) {
    const { statuses } = (await api.listImportStatuses({
      orgId,
      source: src.source,
      auth,
      targetRef: target.id,
    })) as { statuses: SourceStatus[] };
    if (statuses.length) {
      const reviewers = (await api.listReviewCandidates({ orgId })) as Member[];
      const mapped = await mapStatuses(statuses, reviewers, ask);
      statusMap = mapped.statusMap;
      reviewerByStatus = Object.keys(mapped.reviewerByStatus).length
        ? mapped.reviewerByStatus
        : undefined;
    }
  }

  // --- confirm ---------------------------------------------------------------
  // Named in full before anything is written. An import creates a project's worth of
  // issues and mints a placeholder per source author; undoing a mistake means an owner
  // deleting the whole project from the Dash (RTSC-812), placeholders and all.
  console.log(
    `\nAbout to import ${clean(target.name)} from ${clean(src.label)} into org ${orgLabel},\n` +
      `as a new project. Issues, comments and their authors come across.`,
  );

  // RTSC-526 — the second run is the dangerous one, and the terminal is where a command
  // gets re-run casually. Read from `importHistory` (permanent) rather than `latestImport`
  // (live progress, swept after 24h), so this still fires for someone who imported last
  // week and has been working in Retasc since — the person with the most to lose.
  const history = (await api.importHistory({ orgId })) as Array<{
    source: string;
    lastImportedAt?: number | null;
  }>;
  const warning = reimportWarning(history, src.source, src.label);
  if (warning) console.log(warning);

  if (!opts.yes && !(await confirm("This can't be undone. Go ahead?"))) {
    console.log("Nothing imported.");
    return null;
  }

  // --- run -------------------------------------------------------------------
  console.log("\nImporting…\n");

  // RTSC-526 — show it moving. The run is server-side and can take minutes on a big
  // project; a silent wait is exactly when someone decides it has hung and presses Ctrl-C,
  // which is the worst moment to do it because the server keeps going regardless.
  const stop = followProgress(orgId!);

  let res;
  try {
    res = (await api.runImport({
      orgId,
      source: src.source,
      auth,
      target: { id: target.id, key: target.key, name: target.name },
      statusMap,
      reviewerByStatus,
    })) as { projectId: string; summary?: Record<string, number | string> };
  } catch (e) {
    stop();
    // The run is server-side, so a dead connection here does NOT mean a dead import.
    // Saying "failed" would be a guess, and the wrong one sends someone re-importing on
    // top of a run that is still writing.
    const { code, message, hint } = formatError(e);
    console.error(`\n✗ ${code ? `${code}: ` : ""}${message}`);
    if (hint) console.error(`  → ${hint}`);
    console.error("  If this was a connection problem the import may still be running.");
    console.error("  Check the Dash before running it again.");
    throw e;
  }

  stop();
  console.log("\n✓ Imported.");
  for (const line of summaryLines(res.summary as Record<string, unknown> | null, src.label)) {
    console.log(line);
  }
  // The import just minted a placeholder for whoever authored that work, and the person
  // who ran it is very often one of them. `identityLoop` is the same prompt `join` uses and
  // is per-source since RTSC-507, so offering it here costs one round trip and saves them
  // finding it later.
  console.log("");
  const { identityLoop } = await import("./join.js");
  await identityLoop(orgId, {}, orgLabel);

  return { projectId: res.projectId as string, prefix: target.key };
}

/** `retasc import` — the standalone command. Resolves the org, then runs the flow above. */
export async function importAction(opts: ImportOpts): Promise<void> {
  if (!isInteractive() && !opts.yes) {
    cliError(
      "NEEDS_TERMINAL",
      "Importing asks what each of your columns means, so it needs a terminal.",
      "Run it interactively, or use the Dash.",
    );
  }

  const me = (await api.me()) as { orgs?: Array<{ id: string; name: string; slug?: string }> };
  const orgs = me.orgs ?? [];
  let orgId = opts.orgId;
  if (!orgId) {
    if (orgs.length === 0) cliError("NO_ORG", "You're not a member of any org yet.");
    else if (orgs.length === 1) orgId = orgs[0].id;
    else {
      const chosen = await pickExisting("Import into which org", orgs, (o) =>
        `${clean(o.name)}${o.slug ? ` (${clean(o.slug)})` : ""}`,
      );
      orgId = chosen.id;
    }
  }
  const orgLabel = clean(orgs.find((o) => o.id === orgId)?.name ?? "this org");
  await runImportFlow({ orgId: orgId!, orgLabel, source: opts.source, yes: opts.yes });
}
