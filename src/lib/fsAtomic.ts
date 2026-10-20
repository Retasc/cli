import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * RTSC-1154 — write beside the target, then rename over it. For files another tool reads
 * at its own startup (Gemini's settings, OpenCode's plugin, Pi's MCP config) and that we
 * now rewrite unattended: a tool starting at that moment reads the old file or the new
 * one, never half of one. The original's mode is kept.
 */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.retasc-${process.pid}.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  renameSync(tmp, path);
}
