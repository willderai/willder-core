import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gmail/Outlook OAuth callback: a successful connect replaces only an earlier
// row for the SAME mailbox account (a reconnect). A second, different mailbox of
// the same provider in the same org is its own connection and must survive.
//
// Unlike mailbox-oauth.test.ts, which pins each query's predicate, the db here
// is a small in-memory table that applies whatever `where` the route passes
// (field equality plus `{ not }`). So these tests observe which rows the route's
// own predicate removes, without restating the rule in the double.

type Row = {
  id: string;
  orgId: string;
  provider: string;
  externalAccountId: string | null;
  status: string;
  [field: string]: unknown;
};

const table: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === "object" && "not" in cond) return row[key] !== (cond as { not: unknown }).not;
    return row[key] === cond;
  });
}

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => {
  const integration = {
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) => table.find((r) => matches(r, where)) ?? null,
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const doomed = table.filter((r) => matches(r, where));
      for (const row of doomed) table.splice(table.indexOf(row), 1);
      return { count: doomed.length };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = table.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }),
    update: vi.fn(),
  };
  return {
    db: {
      integration,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ integration })),
    },
  };
});
vi.mock("@/services/integrations/mailbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integrations/mailbox")>();
  return { ...actual, exchangeCode: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { signState } from "@/services/integrations/connector-oauth";
import { exchangeCode } from "@/services/integrations/mailbox";
import { GET as callback } from "./callback/route";

const ORG = "org_a";
const OTHER_ORG = "org_b";

/** Completes the caller's pending `integrationId` as the given provider-side account. */
function completeConnect(provider: "gmail" | "outlook", integrationId: string, accountId: string) {
  vi.mocked(exchangeCode).mockResolvedValueOnce({
    accountId,
    email: `${accountId}@example.test`,
    tokens: { mock: true },
  });
  const { state } = signState({ integrationId, orgId: ORG, provider });
  return callback(
    new Request(`http://test/api/integrations/${provider}/callback?${new URLSearchParams({ state, code: "c" })}`),
    { params: Promise.resolve({ id: provider }) },
  );
}
const rowIds = () => table.map((r) => r.id).sort();
const rowById = (id: string) => table.find((r) => r.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ENCRYPTION_KEY", "c".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
  vi.mocked(requireAccessContext).mockResolvedValue({ org: { id: ORG }, user: { id: "u1", role: "owner" } } as never);
  table.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mailbox callback: which earlier rows a completed connect replaces", () => {
  it("connecting a second, different Gmail account leaves the first one connected", async () => {
    table.push(
      { id: "int_first", orgId: ORG, provider: "gmail", externalAccountId: "google-sub-1", status: "connected" },
      { id: "int_second", orgId: ORG, provider: "gmail", externalAccountId: null, status: "pending" },
    );

    const res = await completeConnect("gmail", "int_second", "google-sub-2");

    expect(res.headers.get("location")).toBe("https://willder.example/inbox?connected=1");
    expect(rowIds()).toEqual(["int_first", "int_second"]);
    expect(rowById("int_first")).toMatchObject({ status: "connected", externalAccountId: "google-sub-1" });
    expect(rowById("int_second")).toMatchObject({ status: "connected", externalAccountId: "google-sub-2" });
  });

  it("reconnecting the same Gmail account replaces its earlier row", async () => {
    table.push(
      { id: "int_old", orgId: ORG, provider: "gmail", externalAccountId: "google-sub-1", status: "connected" },
      { id: "int_new", orgId: ORG, provider: "gmail", externalAccountId: null, status: "pending" },
    );

    await completeConnect("gmail", "int_new", "google-sub-1");

    expect(rowIds()).toEqual(["int_new"]);
    expect(rowById("int_new")).toMatchObject({ status: "connected", externalAccountId: "google-sub-1" });
  });

  it("a reconnect touches neither another provider nor another org holding the same account id", async () => {
    table.push(
      { id: "int_outlook", orgId: ORG, provider: "outlook", externalAccountId: "shared-id", status: "connected" },
      { id: "int_other_org", orgId: OTHER_ORG, provider: "gmail", externalAccountId: "shared-id", status: "connected" },
      { id: "int_new", orgId: ORG, provider: "gmail", externalAccountId: null, status: "pending" },
    );

    await completeConnect("gmail", "int_new", "shared-id");

    expect(rowIds()).toEqual(["int_new", "int_other_org", "int_outlook"]);
  });
});
