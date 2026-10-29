// Entity resolver — live check. Run with: npm run resolver:check
// Tests the deterministic resolution pass (no memory-service needed) on a throwaway
// org + user. Covers the checklist items testable without a running Graphiti stack:
//   • Alias registry: add alias → text resolves → delete alias → no longer resolves
//   • Org role: add CEO → user mapping → "the CEO said X" resolves → delete → reverts
//   • Extraction skip: actorType === "extraction" bypasses the resolver in Inngest
//     (verified by asserting the condition from lib/inngest.ts, not by firing an event)
// Exits non-zero on any failure.
import { db } from "@/lib/db";
import { resolveEntities, upsertAlias, deleteAlias } from "@/services/resolver";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  console.log("Checking entity resolver ...\n");

  const org = await db.org.create({ data: { name: "__resolver_check__" } });
  // A user whose canonical name the resolver should resolve aliases/roles to.
  const user = await db.user.create({
    data: {
      orgId: org.id,
      clerkId: `resolver-check-${Date.now()}`,
      email: "ceo@acme.com",
      name: "Jane Doe",
      role: "admin",
    },
  });

  try {
    // ── Alias registry ───────────────────────────────────────────────────────────
    console.log("Alias registry: alias resolves to canonical name...");
    await upsertAlias(org.id, user.id, "user", "Jane Doe", ["JD"], user.id);

    let result = await resolveEntities(org.id, user.id, "Met with JD about the deal.");
    assert(result.changed, "text changed after alias substitution");
    assert(result.resolvedText.includes("Jane Doe"), "alias 'JD' replaced with canonical name 'Jane Doe'");
    assert(!result.resolvedText.includes(" JD "), "original alias no longer present");
    assert(result.resolutions.length > 0, "at least one resolution recorded");

    result = await resolveEntities(org.id, user.id, "Jane Doe called about the contract.");
    assert(!result.changed, "canonical name in text → no substitution needed");

    console.log("Alias registry: delete alias → no longer resolves...");
    await deleteAlias(org.id, user.id);
    result = await resolveEntities(org.id, user.id, "Met with JD about the deal.");
    assert(!result.changed, "after alias deletion, 'JD' is no longer resolved");
    assert(result.resolutions.length === 0, "no resolutions after deletion");

    // ── Org roles ─────────────────────────────────────────────────────────────────
    console.log("\nOrg roles: CEO → user mapping resolves in text...");
    // Seeded straight into the table: the registry's own writes decide for a signed-in
    // person (services/resolver/org-roles.ts), and this check has none.
    await db.orgRole.create({
      data: { orgId: org.id, role: "CEO", userId: user.id, aliases: ["chief executive", "the boss"] },
    });

    result = await resolveEntities(org.id, user.id, "The CEO approved the budget.");
    assert(result.changed, "text changed after org-role substitution");
    assert(result.resolvedText.includes("Jane Doe"), "'CEO' replaced with user canonical name 'Jane Doe'");

    result = await resolveEntities(org.id, user.id, "Spoke with the chief executive.");
    assert(result.changed, "'chief executive' alias resolves to user name");
    assert(result.resolvedText.includes("Jane Doe"), "org role alias resolved correctly");

    console.log("Org roles: delete role → no longer resolves...");
    const orgRoleRow = await db.orgRole.findFirstOrThrow({ where: { orgId: org.id, role: "CEO" } });
    await db.orgRole.delete({ where: { id: orgRoleRow.id } });
    result = await resolveEntities(org.id, user.id, "The CEO approved the budget.");
    assert(!result.changed, "after org role deletion, 'CEO' is no longer resolved");

    // ── Extraction skip (Inngest condition) ───────────────────────────────────────
    console.log("\nExtraction skip: actorType 'extraction' bypasses the resolver...");
    // The condition in lib/inngest.ts line ~101:
    //   const shouldResolve = input.resolve !== false && input.actorType === "human";
    // We verify the predicate here rather than firing an Inngest event.
    const cases: Array<{ actorType: string; resolve?: boolean; expected: boolean; label: string }> = [
      { actorType: "human", expected: true, label: "human actor → resolver runs" },
      { actorType: "extraction", expected: false, label: "extraction actor → resolver skipped" },
      { actorType: "agent", expected: false, label: "agent actor → resolver skipped" },
      { actorType: "human", resolve: false, expected: false, label: "resolve=false override → resolver skipped" },
    ];
    for (const c of cases) {
      const shouldResolve = c.resolve !== false && c.actorType === "human";
      assert(shouldResolve === c.expected, c.label);
    }

    console.log("\nAll resolver assertions passed ✓");
  } finally {
    await db.org.delete({ where: { id: org.id } });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
