// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The suppression list's verdict on a text does not depend on how often the text repeats a
// stretch (services/memory/erasure-suppression.ts hashes each distinct stretch once): a name
// mentioned once, a thousand times, or in other spacing and case is found the same, at the
// same erasure, and a text that never names the person is found by none.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_repeatedNames";

describe.skipIf(!QA_URL)("the suppression list finds a name however often a text repeats it", () => {
  let db: PrismaClient;
  let erasedAt: (text: string) => boolean;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { recordSuppressions, loadErasedContentFilter } = await import("./erasure-suppression");
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await recordSuppressions(db, ORG, "qa", {
      emails: ["orla@example.com"],
      names: ["Orla Brennick", "Anne-Marie Zoë Kai"],
      contactIds: [],
    });
    const filter = await loadErasedContentFilter(ORG);
    erasedAt = (text) => filter(text, new Date(0), null);
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  const filler = "The review covered the cursor and the limit. ";
  const cases: [string, boolean][] = [
    ["Orla Brennick signed it.", true],
    [`${filler.repeat(400)}Orla Brennick signed it.`, true],
    [`${"Orla Brennick signed it. ".repeat(1000)}`, true],
    [`${filler.repeat(300)}ORLA   brennick, again`, true],
    [`${"anne-marie zoë kai and ".repeat(200)}nobody else`, true],
    [`${"anne-marie zoë kai ".repeat(50)}`, true],
    [`${"write to orla@example.com ".repeat(100)}`, true],
    [`${filler.repeat(500)}Orla Brennickson and Brennick Orla`, false],
    [`${"orla ".repeat(300)}${"brennick ".repeat(300)}`, true],
    [filler.repeat(1000), false],
  ];

  it("stores digests exactly as earlier code did, so entries recorded before still match", async () => {
    const stored = await db.erasureSuppression.findMany({
      where: { orgId: ORG, kind: "email" },
      select: { digest: true },
    });
    expect(stored.map((row) => row.digest)).toEqual([
      createHash("sha256").update(`${ORG}\0email\0orla@example.com`).digest("hex"),
    ]);
  });

  it("reaches the same verdict on each text as on its first mention alone", () => {
    expect(cases.map(([text]) => erasedAt(text))).toEqual(cases.map(([, named]) => named));
  });
});
