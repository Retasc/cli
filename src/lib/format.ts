import { clean } from "./text.js";

// RTSC-521 — the CLI's human-readable views.
//
// Five commands used to answer a person with `JSON.stringify(res, null, 2)`, including
// `whoami`, which is the command someone runs to find out who they are. The one fact they
// wanted was a bracket to parse, next to a Convex document id that means nothing to them.
//
// The "it's good for the agent" defence does not apply: agents never see CLI stdout. They
// talk to MCP directly, and `whoami` exists there as its own tool. Nothing was reading
// these payloads but a human.
//
// PURE, and returning strings rather than printing them, for two reasons. Tests can pin the
// wording without scraping stdout, and every one of these values came off the wire — so
// `clean()` belongs at the point of formatting, once, rather than at each interpolation
// where a later line can forget it.
//
// The shape follows `commands/billing.ts`, which already got this right: an aligned summary
// by default, `--json` for the raw payload. It is one pattern, not two.

/** Width of the label column. Matches billing.ts's `row()` so the CLI reads as one tool. */
const LABEL = 13;

/** One `label   value` line. Multi-line values stay hung under the value column. */
export function labelled(rows: Array<[string, string]>): string {
  return rows
    .map(([label, value]) => {
      const [head, ...rest] = String(value).split("\n");
      const pad = " ".repeat(LABEL);
      return [`${label.padEnd(LABEL)}${head}`, ...rest.map((r) => `${pad}${r}`)].join("\n");
    })
    .join("\n");
}

/**
 * An aligned table, or a plain sentence when there is nothing in it.
 *
 * `empty` is required rather than optional: a list command that prints a bare header row
 * and nothing else reads like a failure, and every caller has something truer to say.
 */
export function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return empty;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  // The last column is never padded — trailing spaces are invisible until someone copies
  // a line out of their terminal and finds them.
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * A raw epoch is the specific thing this issue exists to remove: a revoked key reading as
 * `1785660358922` is a number someone skims past, and "revoked" is the fact.
 */
export function ago(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A date a human can read, for a deadline rather than an elapsed time. */
export function day(ms: number | null | undefined): string {
  return ms == null ? "—" : new Date(ms).toISOString().slice(0, 10);
}

// --- the five views --------------------------------------------------------

export type Me = {
  user?: { id?: string; name?: string; email?: string };
  orgs?: Array<{ id: string; name: string; slug?: string; role?: string; deleting?: boolean }>;
};

/**
 * Who you are, and where you can act.
 *
 * The user id is dropped: nothing a person types accepts it. The org id is KEPT, because
 * the very next command genuinely wants it (`retasc bind --org-id …`, `members invite
 * --org-id …`) — the same reason the Dash surfaces it on the Settings page.
 */
export function whoamiView(me: Me): string {
  const u = me.user ?? {};
  const who = [u.name, u.email && `<${u.email}>`].filter(Boolean).map(clean).join(" ");
  const orgs = me.orgs ?? [];
  return labelled([
    ["Signed in", who || "unknown"],
    [
      "Orgs",
      // Said in words. An empty array printed as `[]` is the exact moment this command
      // stops answering the question it was asked.
      orgs.length === 0
        ? "none"
        : orgs
            .map((o) => {
              const bits = [clean(o.name)];
              if (o.slug) bits.push(`(${clean(o.slug)})`);
              const tail = [o.role && clean(o.role), o.deleting && "DELETING"].filter(Boolean);
              // `o.id` is Convex-generated and so not attacker-influenced today. Cleaned
              // anyway: this function's job is that nothing reaches a terminal unsanitised,
              // and one raw interpolation is how the next field added here gets missed.
              return `${bits.join(" ")}${tail.length ? ` · ${tail.join(" · ")}` : ""}\n  ${clean(o.id)}`;
            })
            .join("\n"),
    ],
  ]);
}

export function orgCreatedView(res: { orgId?: string; slug?: string }, name: string): string {
  // `ownerMemberId` is deliberately not shown. It comes back in the payload and there is no
  // command that takes it, so printing it is noise a reader has to decide to ignore.
  return [
    `✓ Created org "${clean(name)}"${res.slug ? ` (${clean(res.slug)})` : ""}.`,
    "",
    labelled([["Org id", clean(res.orgId ?? "—")]]),
    "",
    `Next:  retasc bind --org-id ${clean(res.orgId ?? "<id>")}`,
  ].join("\n");
}

export function projectCreatedView(
  res: { projectId?: string; prefix?: string },
  name: string,
): string {
  return [
    `✓ Created project "${clean(name)}"${res.prefix ? ` (${clean(res.prefix)})` : ""}.`,
    "",
    labelled([["Project id", clean(res.projectId ?? "—")]]),
    "",
    `Issues here will be numbered ${clean(res.prefix ?? "PREFIX")}-1, ${clean(res.prefix ?? "PREFIX")}-2, and so on.`,
  ].join("\n");
}

export type KeyRow = {
  displayPrefix?: string;
  name?: string;
  project?: string;
  agent?: string;
  runtime?: string | null;
  parentKeyId?: string | null;
  lastUsedAt?: number | null;
  revokedAt?: number | null;
};

/**
 * The org's agent keys.
 *
 * Session keys (RTSC-50) are folded into a count rather than listed. They are auto-minted
 * per session and can outnumber the real workspace keys many to one, which is why the Dash
 * groups them too — a list where the manageable rows are lost among machine-minted children
 * is a list nobody reads.
 */
export function keyListView(rows: KeyRow[], now: number = Date.now()): string {
  const workspace = rows.filter((k) => !k.parentKeyId);
  const sessions = rows.length - workspace.length;
  const body = table(
    ["KEY", "PROJECT", "AGENT", "RUNTIME", "LAST USED"],
    workspace.map((k) => [
      clean(k.displayPrefix ?? k.name ?? "—"),
      clean(k.project ?? "—"),
      clean(k.agent ?? "—"),
      clean(k.runtime ?? "—"),
      // State first: a revoked key that reads as a date is one someone counts as live.
      k.revokedAt ? "revoked" : ago(k.lastUsedAt, now),
    ]),
    "No keys yet. Mint one with `retasc key mint`.",
  );
  return sessions > 0
    ? `${body}\n\n(${sessions} session key${sessions === 1 ? "" : "s"} not shown — auto-minted per agent session.)`
    : body;
}

export type InviteRow = {
  displayPrefix?: string;
  role?: string;
  status?: string;
  invitedBy?: string | null;
  expiresAt?: number | null;
  // RTSC-664 — the project NAMES this code confers (RTSC-665 moved the server off
  // prefixes); null/absent ⇒ every project.
  projects?: string[] | null;
};

export function inviteListView(rows: InviteRow[]): string {
  return table(
    ["CODE", "ROLE", "PROJECTS", "STATUS", "INVITED BY", "EXPIRES"],
    rows.map((i) => [
      clean(i.displayPrefix ?? "—"),
      clean(i.role ?? "—"),
      // "All" rather than a dash: an unscoped invite grants MORE than a scoped one,
      // and a column that renders the widest grant as an em dash reads as "none".
      //
      // RTSC-666 — comma-joined, not space-joined. A space was unambiguous while the
      // server sent PREFIXES, which never contain one; it sends names now, so two
      // projects rendered as "XTRO XTRO Marketing" — three words, or one badly named
      // thing, but not two projects. Matches how the Dash joins the same list.
      i.projects == null ? "All" : clean(i.projects.join(", ") || "—"),
      clean(i.status ?? "—"),
      clean(i.invitedBy ?? "—"),
      // Only a LIVE invite has a deadline worth reading. On a spent one the date is
      // still in the payload and still means nothing.
      i.status === "pending" ? day(i.expiresAt) : "—",
    ]),
    "No invites yet. Create one with `retasc members invite --org-id <id>`.",
  );
}

// --- the claim-lifecycle + issue views (RTSC-709) --------------------------
//
// Same rule as the five above: pure, string-returning, `clean()` applied once at the
// point of formatting. These four exist because `retasc claim`, `retasc tidy` and
// `retasc done` all reason about an issue the CLI could not show anybody, so the human
// running them had to open the Dash to check the thing they were about to act on.

/** A member as `get_issue` returns one: a name, plus the human behind an agent. */
export type MemberRef =
  | { name?: string; principal?: string; runtime?: string | null; isAgent?: boolean }
  | null
  | undefined;

/**
 * Who a member is, in one phrase.
 *
 * An agent's `principal` is kept because it answers the question the name raises: three
 * rows reading "Em de Vries's claude-code" are three sessions of one person, and without
 * the principal a reader cannot tell an agent's name from a human's.
 */
export function memberRef(m: MemberRef, fallback = "none"): string {
  if (!m || !m.name) return fallback;
  const name = clean(m.name);
  return m.principal && m.principal !== m.name ? `${name} (for ${clean(m.principal)})` : name;
}

/**
 * `clean()`, line by line, so newlines survive.
 *
 * `clean()` maps every control character to a space, and a newline is one, which is right
 * for a name in a table and wrong for the two fields that are prose. A body run through it
 * whole comes back as a single unreadable paragraph (caught the first time `issue show` was
 * pointed at a real issue), and the body is the reason the command exists.
 */
function block(s: string): string {
  return String(s)
    .split(/\r?\n/)
    .map(clean)
    .join("\n");
}

export type IssueDetail = {
  id?: string;
  title?: string;
  body?: string;
  status?: string;
  work?: boolean;
  priority?: number;
  priorityLabel?: string;
  cancelReason?: string | null;
  createdBy?: MemberRef;
  assignee?: MemberRef;
  createdAt?: number;
  updatedAt?: number;
  dueAt?: number | null;
  slaState?: string;
  labels?: string[];
  relations?: { blocks?: string[]; blockedBy?: string[]; related?: string[]; duplicateOf?: string[] };
  blocked?: boolean;
  blockedByOpen?: Array<{ id: string; status: string }>;
  checkpoint?: { note?: string; by?: string | null; at?: number | null } | null;
  reclaimCount?: number;
  sourceUrl?: string | null;
};

/**
 * One issue, as a person reads it: the header line first, then the fields that decide
 * whether to act on it, then the body.
 *
 * The body is printed in full rather than truncated. This command exists so `tidy` and
 * `done` can be judged without the Dash, and a body cut off at N lines sends the reader
 * straight back to the Dash for the rest.
 */
export function issueView(i: IssueDetail, now: number = Date.now()): string {
  const rows: Array<[string, string]> = [
    // Status first: it is the field `done` and `tidy` both turn on.
    ["Status", clean(i.status ?? "—") + (i.work === false ? " (container, not claimable)" : "")],
    ["Priority", clean(i.priorityLabel ?? (i.priority != null ? String(i.priority) : "—"))],
    ["Assignee", memberRef(i.assignee)],
    ["Author", memberRef(i.createdBy, "—")],
  ];
  if (i.labels?.length) rows.push(["Labels", clean(i.labels.join(", "))]);
  // Said only when true. "Blocked  no" on every issue is a line every reader learns to skip,
  // and then misses on the one issue where it says yes.
  if (i.blocked) {
    const by = (i.blockedByOpen ?? []).map((b) => `${clean(b.id)} (${clean(b.status)})`).join(", ");
    rows.push(["Blocked by", by || "yes"]);
  }
  if (i.dueAt != null) rows.push(["Deadline", `${day(i.dueAt)}${i.slaState ? ` (${clean(i.slaState)})` : ""}`]);
  rows.push(["Created", ago(i.createdAt, now)], ["Updated", ago(i.updatedAt, now)]);
  if (i.reclaimCount) rows.push(["Reclaimed", `${i.reclaimCount}×`]);
  if (i.sourceUrl) rows.push(["Source", clean(i.sourceUrl)]);
  if (i.cancelReason) rows.push(["Canceled", clean(i.cancelReason)]);
  // The checkpoint is the handoff note, so it is shown whole, under its own label.
  if (i.checkpoint?.note) {
    const by = i.checkpoint.by ? ` by ${clean(i.checkpoint.by)}` : "";
    rows.push(["Checkpoint", `${ago(i.checkpoint.at, now)}${by}\n${block(i.checkpoint.note)}`]);
  }
  const rel = i.relations ?? {};
  for (const [label, ids] of [
    ["Blocks", rel.blocks],
    ["Blocked by", i.blocked ? undefined : rel.blockedBy],
    ["Related", rel.related],
    ["Duplicate of", rel.duplicateOf],
  ] as const) {
    if (ids?.length) rows.push([label, clean(ids.join(", "))]);
  }

  const head = `${clean(i.id ?? "—")}  ${clean(i.title ?? "")}`.trimEnd();
  const body = (i.body ?? "").trim();
  return [head, "", labelled(rows), ...(body ? ["", block(body)] : [])].join("\n");
}

export type IssueRow = {
  id?: string;
  title?: string;
  status?: string;
  priorityLabel?: string;
  assignee?: string | MemberRef;
  slaState?: string;
  updatedAt?: number;
};

/**
 * The compact list. Titles are not truncated: `list_issues` is already capped by `--limit`,
 * and a title cut mid-sentence is the version a reader has to re-run the command to finish.
 */
export function issueListView(rows: IssueRow[], now: number = Date.now()): string {
  return table(
    ["ID", "STATUS", "PRIORITY", "ASSIGNEE", "UPDATED", "TITLE"],
    rows.map((r) => [
      clean(r.id ?? "—"),
      clean(r.status ?? "—"),
      clean(r.priorityLabel ?? "—"),
      // list_issues sends the assignee as a plain name; get_issue sends an object. Take both
      // so one row shape can never render as "[object Object]".
      typeof r.assignee === "string" ? clean(r.assignee) : memberRef(r.assignee, "—"),
      ago(r.updatedAt, now),
      // The SLA state rides on the title so a breaching issue cannot be skimmed past, and
      // "ok" is omitted, which is every issue without a deadline.
      `${r.slaState && r.slaState !== "ok" ? `[${clean(r.slaState)}] ` : ""}${clean(r.title ?? "")}`,
    ]),
    "No issues match. Try `retasc issue list --status todo` or widen the filters.",
  );
}

export type ClaimStatus = {
  issue?: string;
  youHold?: boolean;
  status?: string;
  expiresAt?: number | null;
  lastRenewedAt?: number | null;
  heldBy?: { holder?: string; principal?: string; runtime?: string; session?: string };
};

/**
 * `check_claim`, rendered.
 *
 * `lastRenewedAt` is the whole point (RTSC-646): the CLI is where a human runs this twice
 * across a long stretch to prove something is renewing the lease. So it is printed as a
 * clock time AND as an elapsed one, because "17:42" is what you compare between two runs
 * and "8m ago" is what tells you it moved.
 */
export function claimStatusView(c: ClaimStatus, now: number = Date.now()): string {
  const rows: Array<[string, string]> = [
    ["Issue", clean(c.issue ?? "—")],
    ["Holder", c.youHold ? "you (this session)" : clean(c.status ?? "—")],
  ];
  if (!c.youHold && c.heldBy) {
    const h = c.heldBy;
    const who = [h.holder && clean(h.holder), h.principal && `for ${clean(h.principal)}`, h.session && `session ${clean(h.session)}`]
      .filter(Boolean)
      .join(" · ");
    if (who) rows.push(["Held by", who]);
  }
  if (c.expiresAt != null) {
    const left = Math.round((c.expiresAt - now) / 60000);
    rows.push(["Expires", `${time(c.expiresAt)} (${left > 0 ? `in ${left}m` : "expired"})`]);
  }
  if (c.lastRenewedAt != null) rows.push(["Last renewed", `${time(c.lastRenewedAt)} (${ago(c.lastRenewedAt, now)})`]);

  const tail =
    c.status === "other_session"
      ? // RTSC-658: the holder named above is often this human's own previous session, and the
        // remedy is a re-claim, not waiting out the lease.
        "\n\nA restart or /resume looks like a different session. If that holder was you,\nre-claim it with the same token: retasc claim " +
        clean(c.issue ?? "<RTSC-NN>")
      : c.lastRenewedAt != null && c.youHold
        ? "\n\nRun this again later: a Last renewed that moved proves something is renewing you,\none frozen at claim time means nothing is."
        : "";
  return labelled(rows) + tail;
}

/** Wall-clock, local, for a lease you are comparing between two runs. */
function time(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

/**
 * The readback `retasc done` prints before it closes anything (RTSC-709).
 *
 * `done` is one word that writes a terminal status, and it shipped with no read path in
 * front of it: it closed RTSC-706 while that PR was open and unreviewed, printed a tick,
 * and moved on to offering branch deletion. This is the sentence that would have caught it.
 */
export function doneReadback(i: IssueDetail, merged: boolean | null, base: string): string {
  const rows: Array<[string, string]> = [
    ["Issue", `${clean(i.id ?? "—")}  ${clean(i.title ?? "")}`.trimEnd()],
    ["Status", `${clean(i.status ?? "—")} → done`],
  ];
  if (i.assignee) rows.push(["Assignee", memberRef(i.assignee)]);
  // `base` is the trunk `done` actually measured against (RTSC-799) — naming it is
  // the difference between a reader trusting this line and being able to check it.
  if (merged !== null) rows.push(["Branch", merged ? `merged into ${base}` : `NOT merged into ${base}`]);
  return labelled(rows);
}
