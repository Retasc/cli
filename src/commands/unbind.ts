import { api } from "../api.js";
import { isLoggedIn } from "../config.js";
import { readLocalBinding } from "../lib/binding.js";
import { getBinding, removeBinding, keystorePath } from "../lib/keystore.js";
import { confirm, isInteractive } from "../lib/prompt.js";
import { removeProjectMarker, tryClaudeCliRemove } from "./mcp.js";

/**
 * `retasc unbind` — put a folder back the way it was before `bind` (RTSC-721).
 *
 * Until this existed, undoing a binding meant knowing about, and hand-editing, five
 * places: the keystore (keyed by an opaque ws_… id nothing surfaces), the folder's
 * `.mcp.json`, Claude Code's local scope, the session file, and a server-side key that
 * stayed LIVE through all of it. Mihnea, after repeated onboarding tests: "wipe clean is
 * quite hard." It is also how you recover from binding the wrong folder — which nearly
 * happened the same day, a `bind` about to connect `/Users` itself — and a wrong binding
 * has no symptom once written (RTSC-532).
 *
 * Three rules, each earned:
 *
 *   • **Say what it will remove, then wait.** Same rule RTSC-716 set for the write side:
 *     nothing irreversible happens without the human seeing the absolute path. `bind`
 *     confirms before connecting; disconnecting is not less destructive.
 *   • **Revoke, don't merely forget.** Dropping the local copy while the key stays live
 *     is the worse half of what hand-editing did. Best-effort — the session may lack the
 *     rights, or be signed out — and when it can't, it says where to finish the job
 *     rather than pretending it did.
 *   • **The session is left alone.** Signing out is `logout`'s job; conflating the two
 *     turns "detach this folder" into "log me out everywhere", which nobody asked.
 */
/**
 * The prefix the SERVER stored for a raw key — `displayPrefixOf` in `convex/lib/keys.ts`,
 * mirrored here because the CLI cannot import backend code.
 *
 * RTSC-810: this length is the join `unbind` revokes on, and it was wrong. The local side
 * sliced 12 while the server stores 14, so the exact compare was never true once, and
 * `unbind` reported "not found server-side" on every run while leaving the key LIVE —
 * the same outcome as the `{ keys }` destructure below, from the other half of the same
 * lookup. A change to the server's slice has to change this one; `unbindRevoke810.test.mjs`
 * reads `convex/lib/keys.ts` and fails if the two ever disagree again.
 */
export const DISPLAY_PREFIX_LEN = 14;
export function displayPrefixOf(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LEN);
}

/**
 * This folder's live key among the org's, by display prefix — the join `unbind` revokes
 * on. Takes the ARRAY `listKeys` returns; anything else is "nothing to revoke", never a
 * throw, because the caller's fallback is to name the Dash rather than to fail.
 *
 * WORKSPACE keys only: a session child (`parentKeyId` set) is minted in memory by the
 * proxy and never reaches the keystore, so one matching here would mean revoking a key
 * this folder does not own.
 */
export function liveKeyFor(keys: unknown, prefix: string): { id: string } | undefined {
  if (!Array.isArray(keys) || !prefix) return undefined;
  return keys.find(
    (k: any) =>
      k?.displayPrefix === prefix && !k.revokedAt && !k.parentKeyId && typeof k.id === "string",
  );
}

export async function unbindAction(opts: { yes?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const existing = readLocalBinding(cwd);
  if (!existing) {
    console.log("This folder has no Retasc binding. Nothing to do.");
    return;
  }

  const entry = existing.workspaceId ? getBinding(existing.workspaceId) : undefined;
  const keyPrefix = displayPrefixOf(entry?.key ?? existing.key ?? "");

  console.log(`This will disconnect ${cwd} from Retasc:`);
  if (entry?.orgName || entry?.prefix) {
    console.log(`  bound to: ${entry.orgName ?? entry.orgId} / ${entry.prefix ?? entry.projectId}`);
  }
  if (existing.workspaceId) console.log(`  keystore entry ${existing.workspaceId} in ${keystorePath()}`);
  console.log(`  the retasc MCP entry for this folder`);
  if (keyPrefix) console.log(`  the agent key ${keyPrefix}… (revoked server-side, if this session can)`);

  // Non-interactive without --yes refuses, exactly as rebindGuard does for a replace:
  // a script must not be told success for a destruction it never confirmed.
  if (!(await confirm("Proceed?", opts.yes))) {
    if (!isInteractive()) {
      console.error("✗ refusing to unbind non-interactively — pass --yes.");
      process.exitCode = 1;
    } else {
      console.log("Left unchanged.");
    }
    return;
  }

  // Revoke FIRST, while the keystore still holds what identifies the key. displayPrefix
  // is how the server names keys (the raw value is never stored there), so the first
  // DISPLAY_PREFIX_LEN chars of ours is the join — the server's own slice, not a shorter
  // guess at it (RTSC-810).
  if (entry?.orgId && keyPrefix && isLoggedIn()) {
    try {
      // RTSC-810 — `listKeys` returns a bare ARRAY (as `retasc key list` has always
      // read it). This destructured `{ keys }` off it, got `undefined`, and so every
      // unbind since RTSC-721 printed "not found server-side" and left the key LIVE —
      // the exact half of hand-editing the command exists to stop.
      const mine = liveKeyFor(await api.listKeys({ orgId: entry.orgId }), keyPrefix);
      if (mine) {
        await api.revokeKey({ keyId: mine.id });
        console.log(`✓ Revoked key ${keyPrefix}… server-side.`);
      } else {
        console.log(`· Key ${keyPrefix}… not found server-side (already revoked, or the org is gone).`);
      }
    } catch (e) {
      console.log(
        `· Could not revoke the key from here (${e instanceof Error ? e.message.split("\n")[0] : e}). ` +
          `Revoke ${keyPrefix}… from the Dash → API Keys.`,
      );
    }
  } else if (keyPrefix) {
    console.log(`· Not signed in — revoke ${keyPrefix}… from the Dash → API Keys.`);
  }

  if (existing.workspaceId) {
    removeBinding(existing.workspaceId);
    console.log(`✓ Removed keystore entry ${existing.workspaceId}.`);
  }

  // The marker can live in either legal location, and claude-local WINS at runtime, so
  // both are cleared: leaving that one behind is how a "removed" binding keeps answering.
  const claudeRemoved = tryClaudeCliRemove();
  const folderRemoved = removeProjectMarker(cwd);
  if (claudeRemoved) console.log("✓ Removed the Claude Code (local scope) entry.");
  if (folderRemoved) console.log("✓ Removed the retasc entry from ./.mcp.json.");
  if (!claudeRemoved && !folderRemoved) {
    console.log("· No MCP entry found to remove (it may live in a scope this command cannot edit).");
  }

  console.log(
    "\nDone. Restart your agent so it stops loading the old server. Your sign-in is untouched — " +
      "`retasc logout` if you want that too.",
  );
}
