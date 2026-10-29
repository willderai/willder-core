// writeAuditRow records the origin on every row it writes. That it is the only writer is
// enforced by eslint.audit-writer.mjs, which `npm run scope-gate:check` runs in CI.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { auditLog: { create } } }));

import { writeAuditRow } from "./audit-row";

describe("writeAuditRow", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ id: "row-1", at: new Date("2026-10-06T00:00:00Z") });
  });

  it("records the origin in the row's metadata, beside the caller's own detail", async () => {
    const row = await writeAuditRow({
      orgId: "org-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "memory.read",
      target: "org_1.crew",
      decision: "allow",
      metadata: { capabilityId: "cap-1" },
      origin: "mcp",
    });
    expect(row).toEqual({ id: "row-1", at: new Date("2026-10-06T00:00:00Z") });
    expect(create.mock.calls[0]![0].data.metadata).toEqual({ capabilityId: "cap-1", origin: "mcp" });
  });

  it("does not let caller metadata overwrite the origin", async () => {
    await writeAuditRow({
      orgId: "org-1",
      actorType: "human",
      actorId: "user-1",
      action: "memory.read",
      decision: "deny",
      metadata: { origin: "script" },
      origin: "app",
    });
    expect(create.mock.calls[0]![0].data.metadata).toEqual({ origin: "app" });
  });
});
