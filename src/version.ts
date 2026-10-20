import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the version, read from package.json at runtime relative to
// the COMPILED file (dist/version.js -> ../package.json). A JSON import won't work:
// tsconfig has rootDir "src", so importing ../package.json is outside it.
//
// It lives in its own module because two places now need it — `--version`, and the
// pinned npx fallback the MCP marker may name (RTSC-493). A marker pinned to a version
// this build doesn't match would spawn a different CLI than the one that wrote it.
export const VERSION: string = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string }
).version;
