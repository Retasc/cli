// Local file DOWNLOAD for the MCP proxy (RTSC-681) — the read counterpart to attachFile.ts.
//
// Why this exists: attachments were one-way. Uploading has been a single tool call since
// RTSC-660 (the agent names a path, the proxy uploads with the key it holds), but reading one
// back required `Authorization: Bearer <agent key>` on /attachments/download — a credential the
// model structurally does not have and is explicitly told not to hunt for. So a human could
// attach a certificate for an agent to verify and the agent could see its name and nothing
// else. The proxy already brokers bytes in one direction with a credential the model never
// touches; this is the same trade in reverse.
//
// The cost of the reverse trade is different, and worse, which is why this module is stricter
// than its sibling rather than a mirror image of it. attachFile.ts confines what may be READ,
// because a proxy-side read bypasses the harness's file-access prompt. A proxy-side WRITE
// bypasses the harness's write prompt, and a write is the more dangerous primitive: bytes we
// place in `.claude/settings.json`, `.githooks/`, or a workflow file become someone's next
// command execution. The filename is not ours either — it comes off an attachment row any org
// member (or an importer pulling from Jira, ClickUp or Asana) can influence.
//
// So this side takes no destination from anybody. Downloads land in ONE directory the proxy
// owns, under a sanitized name, never overwriting, never through a symlink. An agent that
// wants the file somewhere else copies it with its own file tools — which the harness DOES
// prompt on. That asymmetry is the whole argument: bypassing the read prompt was unavoidable
// to make upload work at all, bypassing the write prompt is not.

import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

/** The one tool name for "read an attached file", whichever transport can carry the bytes.
 *  The server publishes an INLINE variant under this SAME name (bytes in the tool result,
 *  capped, an image as an image); when a proxy is present it overrides that entry in
 *  `tools/list` with the to-disk form below. One name, the best shape the environment can
 *  actually support — exactly as save_attachment_file works. */
export const FETCH_TOOL_NAME = "get_attachment_file";

/** Matches the server's blob ceiling (MAX_ENCRYPTED_BLOB_BYTES), so nothing storable is
 *  un-readable. Checked against what the server SAYS the size is, and again against what it
 *  actually sent — a length header is a claim, not a guarantee. */
export const MAX_FETCH_BYTES = 50 * 1024 * 1024;

/** Where downloads land, relative to the attach root. Inside the workspace on purpose: a
 *  harness that sandboxes file reads to the project would not be able to open anything we
 *  wrote to the OS temp dir, and a file the agent cannot read is the bug we are fixing. */
export const DOWNLOAD_DIR_SEGMENTS = [".retasc", "attachments"] as const;

export type DownloadTarget = { ok: true; dir: string; path: string; filename: string };
export type DownloadTargetError = { ok: false; error: string };

/** The directory the proxy owns for downloaded attachments. */
export function downloadDir(root: string): string {
  return join(root, ...DOWNLOAD_DIR_SEGMENTS);
}

/**
 * Reduce a server-supplied name to something safe to create INSIDE a directory we own.
 *
 * Every rule here is about a name we did not choose: the row's filename came from whoever
 * uploaded it, or from an importer copying a third-party tracker's field verbatim.
 *  - `basename` first, then a second sweep for separators — `../../.git/hooks/pre-commit` and
 *    an absolute path both collapse to a leaf, and a Windows `..\\` does too.
 *  - control characters and NUL, which truncate paths in some syscalls and lie in terminals.
 *  - a leading dot, so nothing we write can become a dotfile (`.gitignore`, `.npmrc`, `.env`)
 *    even inside our own directory.
 *  - Windows device names (CON, NUL, COM1…), which are not openable as files there.
 *  - length, so a long title can't push us past a filesystem limit and get truncated into a
 *    name that collides with something else.
 * Empty after all that (a name made entirely of stripped characters) falls back to the id,
 * which is unique by construction.
 */
export function sanitizeDownloadName(name: string | undefined, attachmentId: string): string {
  const leaf = basename(String(name ?? "").replace(/[\\/]+/g, "/"));
  let cleaned = leaf
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "") // control characters and NUL, which lie in a terminal and truncate paths
    .replace(/^\.+/, "") // no dotfiles, not even inside a directory we own
    .trim()
    .slice(0, 120);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) cleaned = `file-${cleaned}`;
  return cleaned || `attachment-${attachmentId}`;
}

/**
 * Where `attachmentId`'s bytes go. One directory per attachment (ids are unique and immutable,
 * so two files never contend for a name and a cached file is never the wrong file), under the
 * proxy-owned root. The id is validated rather than sanitized: it comes from the server, it is
 * an opaque token, and anything that isn't one is a bug or an attack, not a name to clean up.
 * The containment check at the end is belt-and-braces — after the id check and the name
 * sanitizer there is no known way to escape, which is exactly when a cheap assertion earns its
 * place.
 */
export function resolveDownloadTarget(
  root: string,
  attachmentId: string,
  filename: string | undefined,
): DownloadTarget | DownloadTargetError {
  const id = String(attachmentId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { ok: false, error: `refusing to write: "${id}" is not a valid attachment id` };
  }
  const dir = join(downloadDir(root), id);
  const name = sanitizeDownloadName(filename, id);
  const path = join(dir, name);
  if (path !== join(dir, basename(path)) || !path.startsWith(dir + sep)) {
    return { ok: false, error: `refusing to write ${path}: it resolves outside ${dir}` };
  }
  return { ok: true, dir, path, filename: name };
}

/**
 * The size of an already-downloaded file, or null if there isn't one. `lstat`, never `stat`:
 * a symlink at this path would make `stat` report the target's size and the agent read
 * whatever it points at, so a symlink counts as "not our file" and is reported as such.
 *
 * A file being present IS a complete download — writes go through a temp file and a rename
 * below, so a crash mid-write can never leave a short file at the final path.
 */
export function existingDownload(path: string): { size: number } | { symlink: true } | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { symlink: true };
  if (!st.isFile()) return null;
  return { size: st.size };
}

/**
 * Create the attachment's directory under `root` one segment at a time, refusing any segment
 * that is a symlink or not a directory (RTSC-806).
 *
 * `mkdirSync(dir, { recursive: true })` follows a symlinked component, so a link planted at
 * `.retasc`, `.retasc/attachments` or `.retasc/attachments/<id>` (say, committed into a repo
 * the agent is working in) would carry our bytes outside the root entirely. Every write below
 * is careful about the LEAF; this is the same care for every directory on the way to it, and
 * it refuses rather than repairs, as the read path does since RTSC-801. `mkdir` comes before
 * the `lstat`, never after, so a link that appears between the two is still the thing checked.
 * The root itself is the workspace the proxy was started in, and is taken as given. Never
 * throws: any filesystem error is a refusal the caller can hand straight to the agent.
 */
export function prepareDownloadDir(target: DownloadTarget, root: string): { ok: true } | DownloadTargetError {
  const rel = relative(root, target.dir);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: `refusing to write: ${target.dir} is not inside ${root}` };
  }
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let st;
    try {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      }
      st = lstatSync(current);
    } catch (e) {
      return { ok: false, error: `could not create ${current}: ${String((e as Error)?.message ?? e)}` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, error: `refusing to write through ${current}: it is a symlink, not a directory. Remove it and try again.` };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: `refusing to write: ${current} is not a directory. Remove it and try again.` };
    }
  }
  return { ok: true };
}

/**
 * Write the downloaded bytes, atomically and without ever following a symlink.
 *
 * Every directory on the way is proven real first (`prepareDownloadDir`). Then `wx` on the
 * temp file so we only ever create, never clobber; `rename` to publish, which REPLACES a
 * symlink sitting at the destination rather than writing through it (the one escape a plain
 * write would allow). A leftover temp file from a killed proxy is removed first — it is inside
 * a directory only this code writes to, and its name is ours.
 */
export function writeDownloadedFile(target: DownloadTarget, bytes: Uint8Array, root: string): void {
  const dir = prepareDownloadDir(target, root);
  if (!dir.ok) throw new Error(dir.error);
  ensureCacheIgnored(root);
  const tmp = `${target.path}.part-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    /* nothing to clean up */
  }
  writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
  renameSync(tmp, target.path);
}

/**
 * Make the download directory ignore itself, once.
 *
 * A customer's certificate, production log or crash dump lands in their working tree, and the
 * agent working there is about to commit something. A `.gitignore` holding `*` inside the
 * directory covers everything in it (itself included) without touching the repo's own
 * `.gitignore`, which is a file we have no business editing.
 *
 * It creates nothing but the file: the directory is made, and proven not to be a symlink, by
 * `prepareDownloadDir` before this runs. A `mkdir -p` here would put the `.gitignore` wherever
 * a planted `.retasc` link pointed.
 */
export function ensureCacheIgnored(root: string): void {
  const dir = downloadDir(root);
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
  } catch {
    /* already there (the common case), or unwritable — never fail a download over this */
  }
}

/** The tool the proxy advertises in place of the server's inline variant. It names the
 *  directory because the model has no other way to learn where the file will appear, and
 *  says the bytes never enter the context so nobody "helpfully" asks for base64 instead. */
export function localFetchToolDef(root: string): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: FETCH_TOOL_NAME,
    description:
      "Read a FILE attached to an issue, in ONE call. Give the attachment id (from " +
      "list_attachments); your local retasc proxy downloads it with the credential it already " +
      "holds and writes it to disk, then hands you the path — read it with your normal file " +
      "tools. You do NOT need an API key for this and must not go looking for one, and you " +
      "must not curl the download URL yourself: the whole point is that the key stays in the " +
      `proxy. Files land under ${downloadDir(root)} (one folder per attachment, never ` +
      "overwritten, git-ignored); copy it elsewhere yourself if you want it kept. Works at any " +
      "size up to the 50MB attachment limit, and the bytes never pass through your context. " +
      "For a link attachment (one saved with save_attachment) there is nothing to download — " +
      "fetch its URL yourself.",
    inputSchema: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "Attachment id, e.g. from list_attachments." },
      },
      required: ["attachment"],
    },
  };
}

/**
 * Put the local tool into a `tools/list` result: replace the server's entry of the same name
 * (so the agent sees the shape this environment can actually serve, not the inline fallback)
 * or append it when the server has none. Appending matters — the proxy needs only
 * `get_attachment` to do its job, so it can offer to-disk downloads against a server deployed
 * before the inline variant existed.
 */
export function mergeFetchTool(tools: unknown, root: string): unknown {
  if (!Array.isArray(tools)) return tools;
  const local = localFetchToolDef(root);
  const idx = tools.findIndex((t) => t && typeof t === "object" && (t as { name?: unknown }).name === FETCH_TOOL_NAME);
  if (idx === -1) return [...tools, local];
  const merged = [...tools];
  merged[idx] = local;
  return merged;
}

/** Does this JSON-RPC message want a LOCAL download? Any call to the tool does: unlike the
 *  upload pair there is no second argument shape to tell them apart, and when a proxy is
 *  present writing to disk is always the better answer — it costs the agent no context and
 *  has no size ceiling. */
export function isLocalFetchCall(msg: unknown): boolean {
  const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
  return !!m && m.method === "tools/call" && m.params?.name === FETCH_TOOL_NAME;
}

/** Turn a download HTTP failure into something the agent can act on — same contract as the
 *  upload side: the status carries the meaning, and a bare "HTTP 402" tells an agent nothing
 *  it can relay to the human who alone can fix it. */
export function downloadFailureMessage(status: number, body: string): string {
  const detail = body.trim() ? ` — ${body.trim()}` : "";
  switch (status) {
    case 401:
      return `download rejected: this proxy's key no longer authenticates${detail}`;
    case 402:
      return (
        `download refused for billing${detail}. PASS THIS TO YOUR HUMAN — you cannot fix it ` +
        `yourself, only an owner can, and until they do every call will keep failing.`
      );
    case 404:
      return `download rejected: no such attachment in this project, or it has no stored file${detail}`;
    default:
      return `download failed with HTTP ${status}${detail}`;
  }
}
