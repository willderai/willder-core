// Prisma / Neon connectivity check. Run any time with: npm run db:check
// Verifies the pg adapter connects, the schema is migrated, and a write/read/
// delete round-trip works. Cleans up after itself. Exits non-zero on failure.
import { db } from "@/lib/db";
import { assertDatabaseReachable } from "@/lib/db-startup";

async function main() {
  console.log("Checking Prisma -> Neon (pg adapter)...");

  // 0. Reachability, before Prisma: a stopped or unmigrated database fails with
  //    one line naming the fix.
  await assertDatabaseReachable();

  // 1. Connectivity + a trivial query. It prints the server's clock, a timestamptz
  //    Prisma reads as the right instant, and compares no column against it.
  // eslint-disable-next-line sql-utc-now/no-session-time-sql
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() as now`;
  console.log("  connected. server time:", now.toISOString());

  // 2. Tables exist (counts prove the migration is applied).
  const [orgs, users, accounts, contacts] = await Promise.all([
    db.org.count(),
    db.user.count(),
    db.account.count(),
    db.contact.count(),
  ]);
  console.log(`  tables OK — orgs:${orgs} users:${users} accounts:${accounts} contacts:${contacts}`);

  // 3. Write/read/cascade-delete round-trip on a throwaway org.
  const org = await db.org.create({ data: { name: "__db_check__" } });
  await db.user.create({
    data: { orgId: org.id, clerkId: "__check_" + org.id, email: "check@willder.dev" },
  });
  const readBack = await db.org.findUnique({
    where: { id: org.id },
    include: { users: true },
  });
  const ok = readBack?.users.length === 1;
  await db.org.delete({ where: { id: org.id } }); // cascade removes the user
  const gone = (await db.org.findUnique({ where: { id: org.id } })) === null;
  console.log(`  round-trip:`, ok && gone ? "OK (write/read/cascade-delete)" : "FAILED");
  if (!ok || !gone) throw new Error("round-trip assertion failed");

  console.log("Prisma connection healthy.");
}

main()
  .catch((e) => {
    console.error("DB check FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
