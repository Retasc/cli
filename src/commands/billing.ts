import { api } from "../api.js";

// RTSC-279 — `retasc billing`: the whole billing picture in the terminal, so you don't
// have to open the Dash to answer "what do I owe / what have I paid".
//
// The CLI is a HUMAN surface (device-login JWT), so this reuses the very functions the
// Dash renders — already owner-gated, and already ORG-scoped across every payment link
// the org has ridden (charges: RTSC-254, payments: RTSC-277). A link change therefore
// never hides prior history here either.
//
// Payments are a LIVE Xenarch read fanned per link, so they can be slow or unavailable;
// they're fetched last and degrade to a note rather than failing the whole command.

/** Metered billing is micro-USDC, so `toFixed(2)` hides real sub-cent amounts. Show up
 * to 6 decimals, trim trailing zeros, keep a 2-decimal floor so money still reads right. */
function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  const trimmed = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const dot = trimmed.indexOf(".");
  const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
  return `$${decimals >= 2 ? trimmed : n.toFixed(2)}`;
}

function date(ms: number | null | undefined): string {
  return ms == null ? "—" : new Date(ms).toISOString().slice(0, 10);
}

function isoDate(s: string | null | undefined): string {
  return s ? s.slice(0, 10) : "—";
}

const row = (label: string, value: string) => console.log(`  ${label.padEnd(22)}${value}`);

export async function billingAction(opts: { orgId?: string; json?: boolean }) {
  // Resolve the org: explicit --org-id wins; otherwise use the only one you're in. With
  // several, ask rather than guess — printing the wrong org's money is worse than an error.
  let orgId = opts.orgId;
  let orgLabel = "";
  const me = await api.me();
  if (!orgId) {
    if (me.orgs.length === 0) throw new Error("You're not a member of any org yet.");
    if (me.orgs.length > 1) {
      const list = me.orgs.map((o: any) => `  ${o.id}  ${o.name}${o.slug ? ` (${o.slug})` : ""}`);
      throw new Error(`Several orgs — pass --org-id <id>:\n${list.join("\n")}`);
    }
    orgId = me.orgs[0].id;
  }
  const org = me.orgs.find((o: any) => o.id === orgId);
  orgLabel = org ? `${org.name}${org.slug ? ` (${org.slug})` : ""}` : String(orgId);
  // Fail early with the actionable message rather than a raw FORBIDDEN from the server.
  // Owner OR admin (RTSC-561) — this mirrors `requireOwnerOrAdmin`, and a stale copy of
  // the rule here would refuse an admin locally for a call the server would have allowed.
  if (org && org.role !== "owner" && org.role !== "admin") {
    throw new Error(`Billing needs the owner or admin role — yours in ${orgLabel} is "${org.role}".`);
  }

  const [status, charges] = await Promise.all([
    api.billingStatus({ orgId: orgId! }),
    api.chargeHistory({ orgId: orgId! }),
  ]);
  // Live Xenarch fan-out — slowest and most failure-prone, so it's last and non-fatal.
  let payments: any = null;
  let paymentsError: string | null = null;
  try {
    payments = await api.orgPayments({ orgId: orgId! });
  } catch (e) {
    paymentsError = String((e as Error)?.message ?? e);
  }

  if (opts.json) {
    console.log(JSON.stringify({ org: orgLabel, status, charges, payments, paymentsError }, null, 2));
    return;
  }

  const s = status as any;
  const c = charges as any;

  console.log(`\nBilling — ${orgLabel}\n`);

  console.log("SUBSCRIPTION");
  row("Status", `${s.status}${s.gated ? " (gated)" : ""}`);
  row("Subscription", s.subscriptionId ?? "none yet");
  if (s.spendingCapUsd != null) {
    row("Budget", `${usd(s.spendingCapUsd)}${s.capPeriod ? ` / ${s.capPeriod.replace("per_", "")}` : ""}`);
  }
  if (s.collectionMessage) row("⚠ Collection", s.collectionMessage);

  console.log("\nMONEY");
  row("Pending (owed now)", usd(s.accruedUsd));
  row("Outstanding", usd(c.outstandingUsd));
  row("Charged (lifetime)", usd(c.chargedUsd));
  row("Collected (lifetime)", usd(c.collectedUsd));
  if (s.creditsUsd > 0) row("Credit remaining", usd(s.creditsUsd));

  // Charges + payments span EVERY link; label the eras so a link change is visible
  // rather than looking like history that vanished.
  const eras: any[] = c.eras ?? [];
  console.log(`\nCHARGES (${c.charges.length}${c.capped ? "+, capped" : ""})`);
  if (c.charges.length === 0) {
    console.log("  none yet");
  } else {
    if (eras.length > 1) console.log(`  across ${eras.length} payment links`);
    for (const ch of c.charges.slice(0, 10)) {
      const era = eras.length > 1 ? `  [${ch.subscriptionId.slice(0, 8)}…]` : "";
      console.log(`  #${String(ch.chargeSeq).padEnd(4)} ${date(ch.bookedAt)}  ${ch.status.padEnd(8)} ${usd(ch.amountUsd)}${era}`);
    }
    if (c.charges.length > 10) console.log(`  … ${c.charges.length - 10} more`);
  }

  console.log("\nPAYMENTS (confirmed on-chain)");
  if (paymentsError) {
    console.log(`  unavailable — ${paymentsError}`);
  } else if (!payments || payments.payments.length === 0) {
    console.log("  none yet");
  } else {
    const ps: any[] = payments.payments;
    const links = new Set(ps.map((p) => p.subscriptionId)).size;
    if (links > 1) console.log(`  across ${links} payment links`);
    for (const p of ps) {
      const era = links > 1 ? `  [${p.subscriptionId.slice(0, 8)}…]` : "";
      const block = p.blockNumber != null ? `block ${p.blockNumber}` : "";
      console.log(`  ${isoDate(p.createdAt)}  ${usd(p.amountUsd).padEnd(10)} ${block}${era}`);
    }
  }
  console.log("");
}
