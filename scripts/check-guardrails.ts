// Guardrails — live check. Run with: npm run guardrails:check
// Exercises the REAL guardrail functions on a throwaway org, then cleans up. Covers:
//   • checkSendCap:          maxSendsPerDay=0 → throws send_cap_exceeded
//   • checkContactGuardrails: unsubscribed contact → throws contact_unsubscribed
//   • checkContactGuardrails: bounced contact → throws contact_bounced
//   • filterSendableContacts: skips unsubscribed/bounced, passes clean contacts
// Exits non-zero on any failure.
import { db } from "@/lib/db";
import { checkSendCap, checkContactGuardrails, filterSendableContacts, GuardrailError } from "@/services/guardrails";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function expectGuardrailCode(fn: () => Promise<void>, code: string, msg: string) {
  try {
    await fn();
    throw new Error("FAILED: " + msg + " — expected a GuardrailError but none was thrown");
  } catch (e) {
    if (e instanceof GuardrailError && e.code === code) {
      console.log("  ✓ " + msg);
    } else {
      throw e;
    }
  }
}

async function main() {
  console.log("Checking guardrails ...\n");
  const org = await db.org.create({ data: { name: "__guardrails_check__" } });
  try {
    // ── Send cap ────────────────────────────────────────────────────────────────
    console.log("checkSendCap (maxSendsPerDay=0 → send_cap_exceeded)...");
    await db.orgPreference.create({ data: { orgId: org.id, maxSendsPerDay: 0, maxDraftsPerDay: 200 } });
    await expectGuardrailCode(
      () => checkSendCap(org.id),
      "send_cap_exceeded",
      "maxSendsPerDay=0 throws send_cap_exceeded",
    );

    // Reset to a permissive cap for the remaining send-cap check.
    await db.orgPreference.update({ where: { orgId: org.id }, data: { maxSendsPerDay: 100 } });
    // Should NOT throw with a fresh org (0 messages sent today).
    await checkSendCap(org.id);
    assert(true, "maxSendsPerDay=100 with 0 sends today passes");

    // ── Contact guardrails ───────────────────────────────────────────────────────
    console.log("\ncheckContactGuardrails (unsubscribed → contact_unsubscribed)...");
    const unsub = await db.contact.create({
      data: { orgId: org.id, name: "Opted Out", email: "out@acme.com", status: "unsubscribed" },
    });
    await expectGuardrailCode(
      () => checkContactGuardrails(org.id, unsub.id),
      "contact_unsubscribed",
      "unsubscribed contact throws contact_unsubscribed",
    );

    console.log("\ncheckContactGuardrails (bounced → contact_bounced)...");
    const bounced = await db.contact.create({
      data: { orgId: org.id, name: "Bounced", email: "bounce@acme.com", status: "bounced" },
    });
    await expectGuardrailCode(
      () => checkContactGuardrails(org.id, bounced.id),
      "contact_bounced",
      "bounced contact throws contact_bounced",
    );

    console.log("\ncheckContactGuardrails (active contact → passes)...");
    const active = await db.contact.create({
      data: { orgId: org.id, name: "Active", email: "active@acme.com", status: "active" },
    });
    await checkContactGuardrails(org.id, active.id);
    assert(true, "active contact with no recent sends passes");

    // ── filterSendableContacts ───────────────────────────────────────────────────
    console.log("\nfilterSendableContacts (skips unsubscribed/bounced, keeps active)...");
    const sendable = await filterSendableContacts(org.id, [unsub.id, bounced.id, active.id]);
    assert(sendable.length === 1 && sendable[0] === active.id, "only the active contact passes the filter");
    assert(!sendable.includes(unsub.id), "unsubscribed contact excluded");
    assert(!sendable.includes(bounced.id), "bounced contact excluded");

    const allSendable = await filterSendableContacts(org.id, [active.id]);
    assert(allSendable.length === 1, "single active contact passes unchanged");

    const none = await filterSendableContacts(org.id, []);
    assert(none.length === 0, "empty input returns empty");

    console.log("\nAll guardrail assertions passed ✓");
  } finally {
    await db.org.delete({ where: { id: org.id } });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
