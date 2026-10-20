// Tolerant MCP tool-result parsing (RTSC-143) — pure, shared by proxy.ts and
// lib/claim.ts (previously two silent near-identical copies). The RTSC-91 footer
// regression survived unnoticed because a payload of `{json}\n\n— footer` failed
// JSON.parse and the parser silently handed back the raw result envelope —
// downstream code (lease tracking, claim parsing) then quietly misbehaved. This
// parser (a) recovers the JSON prefix when the text has trailing non-JSON, and
// (b) says so, so a shape regression is visible in MCP logs instead of vanishing.

export type ToolResultParse = {
  value: unknown;
  /**
   * "json"      — content[0].text parsed cleanly.
   * "recovered" — strict parse failed but a leading JSON value was recovered
   *               (trailing non-JSON text, e.g. a human-facing footer).
   * "raw"       — no text, or nothing parseable: value is the raw result envelope.
   */
  kind: "json" | "recovered" | "raw";
  /** Set on "raw" when text WAS present but yielded no JSON — a real shape break. */
  unparseable?: boolean;
};

/** Pure core: classify + extract the payload from a JSON-RPC tools/call response. */
export function parseToolResult(resp: unknown): ToolResultParse {
  const result = (resp as any)?.result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string" || !text) return { kind: "raw", value: result };
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    /* fall through to prefix recovery */
  }
  // Never RECOVER from an error response: error text is prose that may embed
  // JSON-looking fragments (issue ids, tokens), and a recovered fragment would
  // flow into lease tracking as if the call had succeeded.
  if (!result?.isError) {
    const recovered = parseJsonPrefix(text);
    if (recovered) return { kind: "recovered", value: recovered.value };
  }
  return { kind: "raw", value: result, unparseable: true };
}

const MAX_PREFIX_ATTEMPTS = 16;

/**
 * "Strip trailing junk after the top-level JSON value". Fast path: JSON.parse
 * errors name the offending position (V8/JSC), which for a value-plus-footer is
 * exactly where the junk starts. Fallback: a bounded backward scan for the
 * payload's closing `}`/`]`. Either way a candidate is only accepted when the
 * discarded tail is NOT itself JSON-like — concatenated JSON values (NDJSON
 * style) are a shape break where silently dropping the second value would be
 * worse than the raw fallback.
 */
function parseJsonPrefix(text: string): { value: unknown } | undefined {
  if (!/^\s*[{[]/.test(text)) return undefined; // only object/array payloads

  const accept = (end: number): { value: unknown } | undefined => {
    if (/^\s*[{[]/.test(text.slice(end))) return undefined; // tail is more JSON — refuse
    try {
      return { value: JSON.parse(text.slice(0, end)) };
    } catch {
      return undefined;
    }
  };

  try {
    JSON.parse(text);
  } catch (e) {
    const m = /position\s+(\d+)/i.exec(String((e as any)?.message ?? e));
    if (m) {
      const hit = accept(Number(m[1]));
      if (hit) return hit;
    }
  }

  let end = text.length;
  for (let attempt = 0; attempt < MAX_PREFIX_ATTEMPTS; attempt++) {
    const close = Math.max(text.lastIndexOf("}", end - 1), text.lastIndexOf("]", end - 1));
    if (close < 0) return undefined;
    const hit = accept(close + 1);
    if (hit) return hit;
    end = close; // that candidate wasn't the payload's end — try the previous one
  }
  return undefined;
}

function warnStderr(msg: string): void {
  process.stderr.write(`[retasc] ${msg}\n`);
}

/**
 * The tool payload (JSON inside result.content[0].text), or the raw result.
 * Drop-in for the old silent copies, except a degraded parse now WARNS (stderr —
 * stdout may be the MCP channel): callers that only care about the value keep
 * their one-liner, and a server shape regression is at least visible in logs.
 */
export function toolResult(resp: unknown, warn: (msg: string) => void = warnStderr): unknown {
  const p = parseToolResult(resp);
  if (p.kind === "recovered") {
    warn("tool result had trailing non-JSON text — recovered the leading JSON payload");
  } else if (p.unparseable) {
    warn("tool result text is not JSON — falling back to the raw result envelope");
  }
  return p.value;
}
