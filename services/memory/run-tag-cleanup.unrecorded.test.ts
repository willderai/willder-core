// A run-tag cleanup counts a fact as removed when the store removed it, even when recording
// the removal failed (RemovalNotRecordedError): the fact is gone, and a cleanup that stopped
// there would report it as never removed and leave the rest of the run behind.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ facts: [] as { id: string; scopePath: string }[] }));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("COUNT(*)")) return [{ n: 0 }];
      return listed.facts.map((f) => ({
        ...f,
        entityName: "ltload-20261005213000-writer-1",
        createdAt: new Date(0),
        embedded: true,
      }));
    }),
  },
}));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(async () => ({ allowed: true, reason: "ok" })),
}));
vi.mock("./guarded-store", () => ({ guardedMemory: { removeFact: vi.fn() } }));

import { guardedMemory } from "./guarded-store";
import { RemovalNotRecordedError } from "./fact-change-event";
import { removeRunTag, type RunTagInventory } from "./run-tag-cleanup";
import type { AccessContext } from "@/services/access";

const ORG = "runtagunrecorded";
const DEMO = `org_${ORG}.demo`;
const TAG = "ltload-20261005213000";
const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: "u-admin", role: "admin" }, origin: "app" };

describe("removeRunTag — a removal that landed but was not recorded", () => {
  beforeEach(() => {
    listed.facts = [
      { id: "f1", scopePath: DEMO },
      { id: "f2", scopePath: DEMO },
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("counts the fact as removed and goes on to the next one", async () => {
    vi.mocked(guardedMemory.removeFact)
      .mockImplementationOnce(async () => {
        listed.facts = listed.facts.filter((f) => f.id !== "f1");
        throw new RemovalNotRecordedError("f1", new Error("connection reset"), "audit-1");
      })
      .mockImplementationOnce(async () => {
        listed.facts = listed.facts.filter((f) => f.id !== "f2");
        return { removed: true };
      });
    const reviewed = {
      orgId: ORG,
      scopePath: DEMO,
      tag: TAG,
      facts: listed.facts.map((f) => ({ ...f, entityName: "", createdAt: "" })),
    } as RunTagInventory;

    const removal = await removeRunTag(ctx, reviewed, { orgId: ORG, scopePath: DEMO });

    expect(removal).toMatchObject({ removed: ["f1", "f2"], skipped: [], alreadyGone: [], remaining: 0 });
  });
});
