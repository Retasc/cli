// Local file attachment for the MCP proxy (RTSC-660) — path resolution + the tool it advertises.
//
// Why this exists: every other Retasc write is ONE MCP tool call, because the credential
// lives in the server and the model only names a tool. File upload was the exception.
// `prepare_attachment_upload` handed back a URL and told the caller to Bearer it with "your
// API key", which under MCP the model structurally does not have. What that produced in the
// field (the customer report behind RTSC-660): the agent shelled out to read
// `~/.retasc/bindings.json`, and its harness blocked that twice as credential harvesting.
// Our happy path required the agent to do something indistinguishable from an attack.
//
// The proxy is the one component that can close this without moving the credential: it
// already holds the key and already sees every JSON-RPC message. So the agent names a PATH,
// the proxy reads the bytes and POSTs them. The key never approaches the model and the file
// never passes through its context (a 300KB screenshot as base64 in a tool argument is ~100k
// output tokens, which is why the bytes-over-HTTP design exists in the first place).
//
// The cost of that convenience is the reason this module is mostly rules: a proxy-side read
// bypasses the harness's OWN file-access prompt. Whatever this module agrees to open, a model
// can attach with nobody approving it, so a prompt-injected agent told to "attach the config"
// would otherwise be a clean exfiltration primitive. The confinement below IS the security
// boundary, not hygiene — keep it strict, and keep it here where it is unit-tested, rather
// than inline in the proxy's I/O path.

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { keystorePath } from "./keystore.js";
import { DOWNLOAD_DIR_SEGMENTS } from "./fetchFile.js";

/** The one tool name for "attach a file", whichever transport can carry the bytes. The
 *  server publishes a base64 variant under this SAME name for clients with no proxy; when a
 *  proxy is present it overrides the entry in `tools/list` with the path form below. One
 *  name, the best shape the environment can actually support — the model never has to know
 *  which it got, it just reads the schema it was handed. */
export const ATTACH_TOOL_NAME = "save_attachment_file";

/** Matches the server's `MAX_ENCRYPTED_BLOB_BYTES`. Checked locally too so an oversized file
 *  fails before we spend the upload, and with a message that names the size. */
export const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

/** Env var that widens the root a path may live under. Set it deliberately (a worktree
 *  layout, a screenshots dir); unset, the root is the proxy's cwd. */
export const ATTACH_ROOT_ENV = "RETASC_ATTACH_ROOT";

export type AttachResolution =
  | { ok: true; path: string; filename: string; size: number; dev: number; ino: number }
  | { ok: false; error: string };

/** Files inside the root that carry credentials under a NON-dot name, so the dot rule below
 *  doesn't catch them. Deliberately short: a name denylist is the weakest of the three rules
 *  here (rename the file and it stops applying), and it exists only for the two names this
 *  repo's own conventions put in a workspace. The load-bearing rules are the dot rule, the
 *  keystore rule and the home-root refusal — those hold regardless of naming. */
export const DENIED_ATTACH_NAMES = new Set(["secrets.md", "secrets.txt"]);

/**
 * The directory a file must live under to be attachable. `RETASC_ATTACH_ROOT` if set (a
 * human's deliberate choice — the fleet case is real: agents work in sibling worktrees, so
 * the proxy's cwd is often the main checkout while the file is next door), else the proxy's
 * cwd. Resolved through `realpathSync` so the containment check below compares like with
 * like on macOS, where `/tmp` is a symlink to `/private/tmp` and a naive prefix test on the
 * unresolved root rejects every legitimate path under it.
 */
export function attachRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const configured = (env[ATTACH_ROOT_ENV] ?? "").trim();
  const raw = configured || cwd;
  try {
    return realpathSync(raw);
  } catch {
    return resolve(raw); // non-existent root: nothing will resolve inside it anyway
  }
}

/** Resolve a path without caring whether it exists yet: `realpathSync` if we can, the plain
 *  resolution otherwise. Used for the fixed paths we compare AGAINST (home, the keystore), so
 *  a machine where the keystore hasn't been created yet still gets the rule. */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** One message for both places the link count is checked, so the resolution-time refusal and
 *  the read-time one read identically to whoever sees them. */
function hardLinkError(path: string, links: number): string {
  return (
    `refusing to read ${path}: it has ${links} hard links, so this name may be an alias for a ` +
    `file the rules above would refuse (a hard link is invisible to path resolution). Copy it ` +
    `to a new file and attach the copy.`
  );
}

/** macOS and Windows compare filenames case-insensitively, and `realpathSync` does NOT correct
 *  the case there — it hands back whatever case was asked for. So a purely case-sensitive
 *  compare lets `/users/<name>` past a rule written against `/Users/<name>` while the kernel
 *  happily opens the same directory. Fold on those platforms only; on Linux the case IS the
 *  identity and folding would wrongly conflate two real directories. */
const CASE_BLIND = process.platform === "darwin" || process.platform === "win32";
function samePath(a: string, b: string): boolean {
  return CASE_BLIND ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Is `inner` `outer`, or inside it? Both must already be resolved. */
function isWithin(inner: string, outer: string): boolean {
  if (samePath(inner, outer)) return true;
  const prefix = outer.endsWith(sep) ? outer : outer + sep;
  return samePath(inner.slice(0, prefix.length), prefix);
}

/**
 * Does this root swallow the home directory? A root of `~` or `/` does, and both used to be
 * accepted — which put `~/.retasc/bindings.json` (every org's workspace key, for EVERY
 * workspace on this machine, not just this one) inside the attachable set. There is no
 * legitimate attachment that needs a root that wide, and the failure mode if we allowed one
 * is the worst this module has, so it is refused outright rather than carved down with
 * exceptions. A root BELOW home (`~/projects/foo`) is the normal case and stays fine.
 *
 * An unusable `homedir()` disables the rule rather than widening it. Containers, launchd and
 * systemd units run with HOME cleared, where `homedir()` can be "" — and "" resolves to the
 * process's cwd, which is the DEFAULT root, so folding it in would refuse every attachment on
 * exactly the machines least able to debug it. With no home directory there is also no
 * `~/.retasc` for the rule to be protecting.
 */
export function rootSwallowsHome(root: string): boolean {
  const home = homedir();
  if (!home || !isAbsolute(home)) return false;
  return isWithin(realOrResolved(home), root);
}

/**
 * Resolve a caller-supplied path against `root` and decide whether we are willing to read it.
 *
 * Refusals, and what each one is actually for:
 *  - a root that contains the home directory — see `rootSwallowsHome`. Checked first because
 *    it condemns every path, and the human needs to see WHY rather than a per-file refusal.
 *  - outside `root` — the containment rule. Compared AFTER `realpathSync` on both sides, so a
 *    symlink inside the root pointing at `~/.ssh/id_rsa` is caught: resolving only the
 *    requested path (or neither) is the classic way this check is defeated.
 *  - anything under a `.git` directory — inside the root by construction, and `.git/config`
 *    routinely holds credentials in remote URLs. No legitimate attachment lives there.
 *  - any OTHER dotfile or dot-directory below the root (RTSC-801). Containment alone was never
 *    the whole boundary: the files worth stealing are not outside the workspace, they are in
 *    it. `.env.local`, a legacy inline-key `.mcp.json` and `.retasc/` all sit inside a normal
 *    root, so "confined to the project" was confining an attacker to exactly the secrets. A
 *    dot prefix is the one convention every one of them shares, and attachments are
 *    screenshots, logs and documents — none of which are dotfiles — so the rule costs nothing
 *    real and does not have to be kept in step with a list of names. The ONE carve-out is
 *    `.retasc/attachments/`, which is where this same proxy writes downloads: refusing it would
 *    mean the proxy declining to read a file the proxy just wrote, and "download from one
 *    issue, attach to another" is a real thing agents do. The carve-out steps over exactly
 *    those two segments; anything hidden deeper inside is refused normally.
 *  - `secrets.md` and friends — the same class under a name the dot rule can't see.
 *  - the keystore file, and anything sitting beside it — the dot rule already covers the
 *    default `~/.retasc/`, but `RETASC_DIR` can move it somewhere undotted, and a root INSIDE
 *    that directory would put it above the dot check entirely. Direct children only, not the
 *    subtree, so the default layout's `.retasc/attachments/` stays readable.
 *  - a file with more than one hard link — the rules above judge a NAME, and a hard link gives
 *    one inode a second name. `realpathSync` resolves symlinks but not links, so `ln .env.local
 *    notes.txt` inside the root hands the dot rule a name it has no reason to refuse and the
 *    read follows to the same bytes. Link count is the property that survives renaming, so it
 *    is what gets checked. Real attachments (a screenshot, a log, a build output) have one
 *    link; the fix for the rare tool that hard-links its output is to copy the file.
 *  - not a regular file — a directory, fifo or device isn't an attachment, and reading a fifo
 *    would hang the proxy's stdio loop rather than fail.
 *  - empty / oversized — the server rejects both; failing here costs one round trip less and
 *    can say how big the file actually was.
 *
 * A `~` is deliberately NOT expanded: the home directory is precisely what the root confines
 * away from, so silently reaching it would undo the boundary.
 *
 * What this function decides is only half the guarantee — see `readAttachFile`, which is what
 * actually opens the bytes, because a decision made about a path is not a decision about the
 * file that path names a network round trip later.
 */
export function resolveAttachPath(input: string, root: string): AttachResolution {
  const requested = typeof input === "string" ? input.trim() : "";
  if (!requested) return { ok: false, error: "path is required" };
  if (requested.startsWith("~")) {
    return {
      ok: false,
      error:
        `path "${requested}" starts with ~, which is not expanded. Attachable files must live ` +
        `under ${root}; give a path inside it (relative paths resolve against it).`,
    };
  }
  if (rootSwallowsHome(root)) {
    return {
      ok: false,
      error:
        `refusing to attach anything: the attach root ${root} contains your home directory, ` +
        `which would make every credential on this machine attachable. Set ${ATTACH_ROOT_ENV} ` +
        `to the project directory you actually work in.`,
    };
  }

  const candidate = resolve(root, requested);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, error: `no such file: ${candidate}` };
  }

  // `root + sep` would be "//" for a root of "/", which nothing starts with — so a root of
  // "/" would refuse everything instead of allowing everything. Fail-closed is the right
  // direction, but silently, and only for that one root; normalize instead.
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!isWithin(real, root)) {
    return {
      ok: false,
      error:
        `refusing to read ${real}: it resolves outside ${root}. Only files under that root can ` +
        `be attached (set ${ATTACH_ROOT_ENV} to widen it deliberately).`,
    };
  }

  // Only the segments BELOW the root: the root itself is the human's deliberate choice and may
  // legitimately be a dotted path, so judging it here would refuse everything under it.
  let below = real.slice(prefix.length).split(sep).filter(Boolean);

  // `.retasc/attachments/` is the directory THIS proxy writes downloads into, so a blanket dot
  // rule would make "download the design from RTSC-1, attach it to RTSC-2" impossible — the
  // proxy refusing to read a file the proxy just wrote. Step over those two segments and judge
  // the rest normally, so a hand-placed `.env` deeper inside is still refused.
  if (below.length > DOWNLOAD_DIR_SEGMENTS.length && DOWNLOAD_DIR_SEGMENTS.every((seg, i) => below[i] === seg)) {
    below = below.slice(DOWNLOAD_DIR_SEGMENTS.length);
  }

  if (below.includes(".git")) {
    return { ok: false, error: `refusing to read ${real}: paths inside a .git directory are not attachable.` };
  }
  const dotted = below.find((seg) => seg.startsWith("."));
  if (dotted) {
    return {
      ok: false,
      error:
        `refusing to read ${real}: "${dotted}" is hidden, and hidden files and directories are ` +
        `not attachable. Attach a file that isn't hidden.`,
    };
  }
  // Trailing dots and spaces are stripped by Win32 before the filesystem sees a name, so
  // `secrets.md.` and `secrets.md ` open the same file while a literal compare misses both.
  const leaf = (below[below.length - 1] ?? "").replace(/[. ]+$/, "");
  if (DENIED_ATTACH_NAMES.has(leaf.toLowerCase())) {
    return { ok: false, error: `refusing to read ${real}: that file is not attachable.` };
  }
  // The keystore file itself, and anything sitting beside it in the directory it lives in —
  // `RETASC_DIR` names a credential directory, not just one file. Direct children only: a
  // subtree ban would swallow `.retasc/attachments/` on the default layout, which the carve-out
  // above exists to keep readable.
  const keystore = realOrResolved(keystorePath());
  if (samePath(real, keystore) || samePath(dirname(real), realOrResolved(dirname(keystorePath())))) {
    return {
      ok: false,
      error:
        `refusing to read ${real}: it is in the directory retasc keeps credentials in ` +
        `(RETASC_DIR). Nothing there is attachable.`,
    };
  }

  let size: number;
  let dev: number;
  let ino: number;
  try {
    const st = statSync(real);
    if (!st.isFile()) return { ok: false, error: `not a regular file: ${real}` };
    if (st.nlink > 1) return { ok: false, error: hardLinkError(real, st.nlink) };
    size = st.size;
    dev = st.dev;
    ino = st.ino;
  } catch {
    return { ok: false, error: `cannot stat ${real}` };
  }
  if (size === 0) return { ok: false, error: `refusing to attach an empty file: ${real}` };
  if (size > MAX_ATTACH_BYTES) {
    return {
      ok: false,
      error: `file is ${size} bytes, over the ${MAX_ATTACH_BYTES}-byte attachment limit: ${real}`,
    };
  }

  // The display name comes from what the caller ASKED for, not from the resolved target: a
  // symlink's own name is the one the human recognizes, and it only ever becomes a label.
  return { ok: true, path: real, filename: basename(candidate), size, dev, ino };
}

/**
 * Read the bytes we agreed to read — and prove they are the SAME bytes (RTSC-801).
 *
 * `resolveAttachPath` runs, then the proxy spends a full network round trip on
 * `prepare_attachment_upload`, and only then does the file get opened. Reading by path at that
 * point re-does the lookup against whatever the filesystem holds NOW, which is a window an
 * agent's own shell can drive: a background `ln -sf` loop swaps the approved file for a link
 * to `~/.ssh/id_rsa` and the read follows it, having passed every check above.
 *
 * Three things close it. `O_NOFOLLOW` refuses a symlink as the final component outright.
 * `O_NONBLOCK` keeps a fifo swapped into the window from blocking the whole event loop rather
 * than being refused. And the dev/ino/size comparison covers the rest — an intermediate
 * directory swapped for another one, or the file replaced by a different regular file —
 * because it asks the question that actually matters: is the fd I am holding open on the file
 * I checked? A path can be re-pointed; an open descriptor cannot. Everything after the open
 * reads from the fd, never from the path.
 *
 * What that does NOT cover, stated plainly rather than implied away: a rewrite in place, through
 * the same inode, that lands on exactly the same byte count. Nothing short of hashing the
 * content twice would catch it, and hashing is itself racy and costs a second full read of up
 * to 50MB. It is also the weakest of these attacks by some distance — it needs write access to
 * the file the human already approved AND the secret bytes already in hand, which is an
 * attacker who could simply have named the secret in the first place.
 */
export function readAttachFile(resolved: {
  path: string;
  size: number;
  dev: number;
  ino: number;
}): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  // O_NOFOLLOW is POSIX; on a platform without it we lean on the dev/ino check below.
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  // O_NONBLOCK matters more than it looks. `openSync` on a FIFO with no writer BLOCKS, and it
  // blocks the whole process — not a request, the event loop, so heartbeats stop and every
  // lease this proxy holds goes stale. `resolveAttachPath` rejects a fifo, but a `mkfifo` in
  // the same window this function exists for is never seen by that check, which would turn a
  // refusal into a frozen proxy. Opening non-blocking returns immediately and lets the
  // `isFile` check below refuse it like any other non-file. Harmless on a regular file.
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let fd: number;
  try {
    fd = openSync(resolved.path, constants.O_RDONLY | noFollow | nonBlock);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP" || code === "EMLINK") {
      return { ok: false, error: `refusing to read ${resolved.path}: it became a symlink after it was checked.` };
    }
    return { ok: false, error: `cannot open ${resolved.path}: ${String((e as Error)?.message ?? e)}` };
  }
  try {
    const st = fstatSync(fd);
    // Identity AND size: dev/ino prove the same inode, the size proves it was not rewritten in
    // place through the same inode (`open(path, "r+")` changes neither dev nor ino nor link
    // count). Together they are what "the file that was checked" can honestly mean here.
    if (!st.isFile() || st.dev !== resolved.dev || st.ino !== resolved.ino || st.size !== resolved.size) {
      return { ok: false, error: `refusing to read ${resolved.path}: the file changed after it was checked.` };
    }
    // With no O_NOFOLLOW and no usable inode number there is nothing left proving this
    // descriptor is the file that passed the checks, so refuse rather than pretend. Real on
    // SMB, FAT/exFAT and some FUSE mounts, where `ino` is 0 or not stable.
    if (noFollow === 0 && st.ino === 0) {
      return {
        ok: false,
        error:
          `refusing to read ${resolved.path}: this filesystem reports no stable file id and the ` +
          `platform cannot refuse symlinks on open, so the file cannot be proven unchanged.`,
      };
    }
    // Re-checked on the fd, not just at resolution: a link can be added inside the same window
    // the dev/ino check exists for, and adding one does not change the inode.
    if (st.nlink > 1) return { ok: false, error: hardLinkError(resolved.path, st.nlink) };
    // No separate empty/oversize re-check: resolveAttachPath already refused both, and any size
    // that could newly violate either is a size that differs from the one just compared.
    return { ok: true, bytes: readFileSync(fd) };
  } catch (e) {
    return { ok: false, error: `cannot read ${resolved.path}: ${String((e as Error)?.message ?? e)}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already gone */
    }
  }
}

/** The tool the proxy advertises in place of (or in addition to) the server's base64 variant.
 *  It names the root in the description because the model has no other way to learn where it
 *  may read from, and a refusal it could have avoided costs a whole turn. */
export function localAttachToolDef(root: string): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: ATTACH_TOOL_NAME,
    description:
      "Attach a FILE on this machine to an issue, in ONE call. Give the path; your local retasc " +
      "proxy reads the bytes and uploads them with the credential it already holds. You do NOT " +
      "need an API key for this and must not go looking for one — the whole point is that the " +
      `key stays in the proxy. Readable paths are confined to ${root} (relative paths resolve ` +
      "against it, symlinks out of it are refused, and so is any hidden file or directory, any " +
      "hard-linked file, and anything retasc keeps credentials in). For a plain URL rather than " +
      "a file, use save_attachment instead.",
    inputSchema: {
      type: "object",
      properties: {
        issue: { type: "string", description: "Issue ID, e.g. RTSC-12" },
        path: { type: "string", description: `File path, absolute or relative to ${root}.` },
        title: { type: "string", description: "Optional label; also the download name." },
      },
      required: ["issue", "path"],
    },
  };
}

/**
 * Put the local tool into a `tools/list` result: replace the server's entry of the same name
 * (so the agent sees the shape this environment can actually serve, not the base64 fallback)
 * or append it when the server has none. Appending matters — the proxy only needs
 * `prepare_attachment_upload` to do its job, so it can offer one-call attachment against a
 * server deployed before the base64 variant existed.
 */
export function mergeAttachTool(tools: unknown, root: string): unknown {
  if (!Array.isArray(tools)) return tools;
  const local = localAttachToolDef(root);
  const idx = tools.findIndex((t) => t && typeof t === "object" && (t as { name?: unknown }).name === ATTACH_TOOL_NAME);
  if (idx === -1) return [...tools, local];
  const merged = [...tools];
  merged[idx] = local;
  return merged;
}

/** Does this JSON-RPC message want a LOCAL file upload? Only a `path` argument does: an agent
 *  that sends `contentBase64` is using the server's variant and must be forwarded untouched,
 *  so an older or hand-written client keeps working through a newer proxy. */
export function isLocalAttachCall(msg: unknown): boolean {
  const m = msg as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
  if (!m || m.method !== "tools/call" || m.params?.name !== ATTACH_TOOL_NAME) return false;
  const args = m.params?.arguments as { path?: unknown } | undefined;
  return typeof args?.path === "string" && args.path.trim() !== "";
}

/** Build the upload URL: the server hands back a per-issue endpoint, we add the download-name
 *  hints. `filename` drives the stored name and the server's content-type inference; `title`
 *  is the human label. Both are query params because the endpoint takes the raw bytes as its
 *  entire body. */
export function uploadUrlWith(uploadUrl: string, filename: string, title?: string): string {
  const sepChar = uploadUrl.includes("?") ? "&" : "?";
  const parts = [`filename=${encodeURIComponent(filename)}`];
  if (title && title.trim()) parts.push(`title=${encodeURIComponent(title.trim())}`);
  return `${uploadUrl}${sepChar}${parts.join("&")}`;
}

/** Turn an upload HTTP failure into something the agent can act on. The endpoint answers in
 *  plain text, so the status is what carries the meaning; a bare "HTTP 402" tells an agent
 *  nothing it can relay to the human who alone can fix it. */
export function uploadFailureMessage(status: number, body: string): string {
  const detail = body.trim() ? ` — ${body.trim()}` : "";
  switch (status) {
    case 401:
      return `upload rejected: this proxy's key no longer authenticates${detail}`;
    case 402:
      return (
        `upload refused for billing${detail}. PASS THIS TO YOUR HUMAN — you cannot fix it ` +
        `yourself, only an owner can, and until they do every write will keep failing.`
      );
    case 404:
      return `upload rejected: no such issue in this project${detail}`;
    case 413:
      return `upload rejected: file too large${detail}`;
    default:
      return `upload failed with HTTP ${status}${detail}`;
  }
}
