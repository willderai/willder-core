import { beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

// POST /api/webhooks/clerk. The signature check is the real svix one: each test
// signs its body with a real signing secret, so a test passes only when the
// route really verifies the payload. The database and memory service are mocked;
// the assertions are on whether the route processed the event at all, and which
// membership write it asked for. What those writes do to access is proven on a
// real database in services/access/org-membership.realdb.test.ts.
//
// The case that matters most is the first one: with no signing secret configured
// the route must refuse, never fall through to processing an unverified payload.

vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/services/access", () => ({
  clerkRoleToUserRole: (role: string | undefined) => (role === "org:admin" ? "admin" : "member"),
  recordMembership: vi.fn(async () => undefined),
  recordMembershipRemoved: vi.fn(async () => undefined),
}));

vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn(async () => undefined) },
}));

// An org deletion's side of a membership event, proven on a real database in
// services/memory/org-deletion/clerk-events.realdb.test.ts.
vi.mock("@/services/memory/org-deletion/request", () => ({
  refreshDeletionRecipients: vi.fn(async () => undefined),
  startOrgDeletion: vi.fn(async () => null),
}));
vi.mock("@/services/access/org-deletion-gate", () => ({ orgDeletionOpen: vi.fn(async () => false) }));

import { db } from "@/lib/db";
import { memory } from "@/services/memory";
import { recordMembership, recordMembershipRemoved } from "@/services/access";
import { refreshDeletionRecipients } from "@/services/memory/org-deletion/request";
import { orgDeletionOpen } from "@/services/access/org-deletion-gate";
import { POST } from "./route";

const mockDb = db as unknown as {
  org: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};
const mockRecordMembership = recordMembership as unknown as ReturnType<typeof vi.fn>;
const mockRecordRemoved = recordMembershipRemoved as unknown as ReturnType<typeof vi.fn>;
const mockMemory = memory as unknown as { ingest: ReturnType<typeof vi.fn> };
const mockRefresh = refreshDeletionRecipients as unknown as ReturnType<typeof vi.fn>;
const mockDeletionOpen = orgDeletionOpen as unknown as ReturnType<typeof vi.fn>;

// A valid svix secret is "whsec_" + base64 of the raw key.
const SECRET = `whsec_${Buffer.from("willder-test-signing-key-0123456789").toString("base64")}`;
const SECOND_SECRET = `whsec_${Buffer.from("willder-second-endpoint-key-987654").toString("base64")}`;
const UNKNOWN_SECRET = `whsec_${Buffer.from("a-third-endpoint-nobody-registered").toString("base64")}`;

const EVENT_AT = 1_790_000_000_000;

const EVENT = {
  type: "organizationMembership.created" as
    | "organizationMembership.created"
    | "organizationMembership.updated"
    | "organizationMembership.deleted",
  timestamp: EVENT_AT,
  data: {
    id: "orgmem_1",
    role: "org:admin",
    organization: { id: "org_clerk_1", name: "Acme" },
    public_user_data: { user_id: "user_1", first_name: "Ada", last_name: "Lovelace" },
  },
};

/** A request whose svix headers are a real signature over `body` made with `secret`. */
function signedRequest(body: string, secret = SECRET): Request {
  const id = "msg_test_1";
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(id, timestamp, body);
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
    body,
  });
}

describe("POST /api/webhooks/clerk", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDb.org.findUnique.mockReset().mockResolvedValue({ id: "org_1", name: "Acme" });
    mockDb.user.findUnique.mockReset().mockResolvedValue({ id: "u_1", email: "ada@acme.test" });
    mockDb.user.update.mockReset().mockResolvedValue({});
    mockRecordMembership.mockReset();
    mockRefresh.mockReset();
    mockDeletionOpen.mockReset().mockResolvedValue(false);
    mockRecordRemoved.mockReset();
    mockMemory.ingest.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "");
  });

  it("refuses with 503 and touches nothing when the signing secret is unset", async () => {
    vi.stubEnv("CLERK_WEBHOOK_SECRET", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify(EVENT);

    // Unsigned, as an attacker would send it: no svix headers at all.
    const res = await POST(
      new Request("http://localhost/api/webhooks/clerk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

    expect(res.status).toBe(503);
    expect(mockDb.org.findUnique).not.toHaveBeenCalled();
    expect(mockMemory.ingest).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).toContain("CLERK_WEBHOOK_SECRET");
  });

  it("refuses a correctly signed payload too when the secret is unset", async () => {
    // Even a request that would verify against the real secret is refused, so the
    // 503 is about the server's own configuration, not about the request.
    const req = signedRequest(JSON.stringify(EVENT));
    vi.stubEnv("CLERK_WEBHOOK_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req);

    expect(res.status).toBe(503);
    expect(mockMemory.ingest).not.toHaveBeenCalled();
  });

  it("rejects a bad signature with 401 and touches nothing", async () => {
    const otherSecret = `whsec_${Buffer.from("a-different-key-aaaaaaaaaaaaaaaaaa").toString("base64")}`;
    const res = await POST(signedRequest(JSON.stringify(EVENT), otherSecret));

    expect(res.status).toBe(401);
    expect(mockDb.org.findUnique).not.toHaveBeenCalled();
    expect(mockMemory.ingest).not.toHaveBeenCalled();
  });

  it("rejects a payload whose body was altered after signing", async () => {
    const req = signedRequest(JSON.stringify(EVENT));
    const tampered = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify({ ...EVENT, data: { ...EVENT.data, organization: { id: "org_evil", name: "Evil" } } }),
    });

    const res = await POST(tampered);

    expect(res.status).toBe(401);
    expect(mockDb.org.findUnique).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed membership.created, records the membership and ingests the join", async () => {
    const res = await POST(signedRequest(JSON.stringify(EVENT)));

    expect(res.status).toBe(200);
    expect(mockDb.org.findUnique).toHaveBeenCalledWith({ where: { clerkOrgId: "org_clerk_1" } });
    expect(mockRecordMembership).toHaveBeenCalledWith({
      orgId: "org_1",
      userId: "u_1",
      role: "admin",
      assertedAt: new Date(EVENT_AT),
    });
    expect(mockMemory.ingest).toHaveBeenCalledTimes(1);
    expect(mockMemory.ingest.mock.calls[0][0]).toMatchObject({ groupId: "org_1" });
  });

  it("records a role change from a signed membership.updated", async () => {
    const event = {
      ...EVENT,
      type: "organizationMembership.updated" as const,
      data: { ...EVENT.data, role: "org:member" },
    };
    const res = await POST(signedRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockRecordMembership).toHaveBeenCalledWith({
      orgId: "org_1",
      userId: "u_1",
      role: "member",
      assertedAt: new Date(EVENT_AT),
    });
    expect(mockRecordRemoved).not.toHaveBeenCalled();
    expect(mockMemory.ingest).not.toHaveBeenCalled();
  });

  it("records a removal from a signed membership.deleted, for that org only", async () => {
    const event = { ...EVENT, type: "organizationMembership.deleted" as const };
    const res = await POST(signedRequest(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { clerkId: "user_1" }, select: { id: true } });
    expect(mockRecordRemoved).toHaveBeenCalledWith({ orgId: "org_1", userId: "u_1", removedAt: new Date(EVENT_AT) });
    expect(mockRecordMembership).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledWith("org_1");
  });

  it("records a removal while the org is being deleted, and ingests no departure into it", async () => {
    mockDeletionOpen.mockResolvedValue(true);
    const res = await POST(signedRequest(JSON.stringify({ ...EVENT, type: "organizationMembership.deleted" })));

    expect(res.status).toBe(200);
    expect(mockRecordRemoved).toHaveBeenCalledWith({ orgId: "org_1", userId: "u_1", removedAt: new Date(EVENT_AT) });
    expect(mockRefresh).toHaveBeenCalledWith("org_1");
    expect(mockMemory.ingest).not.toHaveBeenCalled();
  });

  it("records nothing for a person who has never signed in", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    const res = await POST(signedRequest(JSON.stringify({ ...EVENT, type: "organizationMembership.deleted" })));

    expect(res.status).toBe(200);
    expect(mockRecordRemoved).not.toHaveBeenCalled();
    expect(mockRecordMembership).not.toHaveBeenCalled();
  });

  describe("user.created / user.updated record whether the stored email is verified", () => {
    const userEvent = (
      type: string,
      addresses: { email_address: string; verification: { status: string } | null }[],
    ) => ({
      type,
      data: { id: "user_1", email_addresses: addresses },
    });

    it("records true when Clerk verified the exact address Willder stores", async () => {
      const res = await POST(
        signedRequest(
          JSON.stringify(
            userEvent("user.updated", [{ email_address: "Ada@Acme.test", verification: { status: "verified" } }]),
          ),
        ),
      );
      expect(res.status).toBe(200);
      expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { clerkId: "user_1" }, select: { email: true } });
      expect(mockDb.user.update).toHaveBeenCalledWith({ where: { clerkId: "user_1" }, data: { emailVerified: true } });
    });

    it("records false when the stored address is unverified, or only a different address is verified", async () => {
      await POST(
        signedRequest(
          JSON.stringify(
            userEvent("user.created", [
              { email_address: "ada@acme.test", verification: { status: "unverified" } },
              { email_address: "ada@other.test", verification: { status: "verified" } },
            ]),
          ),
        ),
      );
      expect(mockDb.user.update).toHaveBeenCalledWith({ where: { clerkId: "user_1" }, data: { emailVerified: false } });
    });

    it("does nothing for a Clerk user Willder has not synced yet", async () => {
      mockDb.user.findUnique.mockResolvedValue(null);
      const res = await POST(
        signedRequest(
          JSON.stringify(
            userEvent("user.updated", [{ email_address: "ada@acme.test", verification: { status: "verified" } }]),
          ),
        ),
      );
      expect(res.status).toBe(200);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });

    it("never records anything from an unsigned user event", async () => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET", "");
      vi.spyOn(console, "error").mockImplementation(() => {});
      await POST(signedRequest(JSON.stringify(userEvent("user.updated", []))));
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });
  });

  describe("two Clerk endpoints deliver here, each with its own signing secret", () => {
    beforeEach(() => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", SECOND_SECRET);
    });

    it("accepts an event signed by the first endpoint's secret", async () => {
      const res = await POST(signedRequest(JSON.stringify(EVENT), SECRET));

      expect(res.status).toBe(200);
      expect(mockMemory.ingest).toHaveBeenCalledTimes(1);
    });

    it("accepts an event signed by the second endpoint's secret", async () => {
      const res = await POST(signedRequest(JSON.stringify(EVENT), SECOND_SECRET));

      expect(res.status).toBe(200);
      expect(mockMemory.ingest).toHaveBeenCalledTimes(1);
    });

    it("rejects an event signed by any other secret with 401 and touches nothing", async () => {
      const res = await POST(signedRequest(JSON.stringify(EVENT), UNKNOWN_SECRET));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid signature" });
      expect(mockDb.org.findUnique).not.toHaveBeenCalled();
      expect(mockMemory.ingest).not.toHaveBeenCalled();
    });

    it("rejects a body altered after the second endpoint signed it", async () => {
      const req = signedRequest(JSON.stringify(EVENT), SECOND_SECRET);
      const tampered = new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify({ ...EVENT, data: { ...EVENT.data, organization: { id: "org_evil", name: "Evil" } } }),
      });

      const res = await POST(tampered);

      expect(res.status).toBe(401);
      expect(mockDb.org.findUnique).not.toHaveBeenCalled();
    });

    it("accepts the second endpoint's events when only its secret is set", async () => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET", "");

      const res = await POST(signedRequest(JSON.stringify(EVENT), SECOND_SECRET));

      expect(res.status).toBe(200);
      expect(mockMemory.ingest).toHaveBeenCalledTimes(1);
    });

    it("refuses with 503 when neither secret is set, whoever signed the event", async () => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET", "");
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "");
      vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await POST(signedRequest(JSON.stringify(EVENT), SECOND_SECRET));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "webhook signing secret not configured" });
      expect(mockMemory.ingest).not.toHaveBeenCalled();
    });
  });

  // svix strips "whsec_" and base64-decodes the rest, so a secret with no key
  // after the prefix is an empty HMAC key, and one that decodes to zero bytes is
  // HMAC-equivalent to it. Anyone can sign with either, so the route must treat
  // such a value as unusable rather than as a configured secret.
  describe("a configured value that is not a usable signing secret", () => {
    /** A request signed with an empty key, as anyone could make it. */
    const forgedRequest = () => signedRequest(JSON.stringify(EVENT), "whsec_");
    const ALL_ZERO_KEY = `whsec_${Buffer.alloc(24).toString("base64")}`;

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it.each([
      ["the bare prefix", "whsec_"],
      ["a short all-zero key", "whsec_AAAA"],
      ["a full-length all-zero key", ALL_ZERO_KEY],
    ])("never accepts an empty-key forgery when the second secret is %s", async (_label, value) => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", value);

      const res = await POST(forgedRequest());

      expect(res.status).toBe(503);
      expect(mockDb.org.findUnique).not.toHaveBeenCalled();
      expect(mockMemory.ingest).not.toHaveBeenCalled();
    });

    it("never accepts an empty-key forgery when the only secret is an all-zero key", async () => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET", ALL_ZERO_KEY);

      const res = await POST(forgedRequest());

      expect(res.status).toBe(503);
      expect(mockMemory.ingest).not.toHaveBeenCalled();
    });

    it.each([
      ["whitespace", "   "],
      ["no prefix", "abc"],
      ["a key too short to decode", "whsec_abc"],
      ["a trailing newline", `${SECOND_SECRET}\n`],
      ["its base64 padding dropped", SECRET.slice(0, -1)],
      ["an inline comment after the key", `${SECOND_SECRET} # 2`],
    ])("answers 503, not a thrown error, when the second secret has %s", async (_label, value) => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", value);

      const res = await POST(signedRequest(JSON.stringify(EVENT), SECRET));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "webhook signing secret not configured" });
    });

    // HMAC zero-pads a key shorter than its block, so trailing zero bytes add
    // nothing: a secret of one key byte followed by zeros signs exactly like that
    // one byte, which anyone can try.
    describe("a key with too little key material", () => {
      /** "whsec_" followed by the base64 of `bytes`. */
      const secretOf = (bytes: number[]) => `whsec_${Buffer.from(bytes).toString("base64")}`;
      const zeros = (count: number) => new Array<number>(count).fill(0);
      const distinct = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

      it.each([
        ["one key byte followed by 23 zeros", [0x01]],
        ["three key bytes followed by 21 zeros", distinct(3)],
        ["15 key bytes followed by 9 zeros", distinct(15)],
      ])("never accepts a request forged with the short key when the second secret is %s", async (_label, shortKey) => {
        vi.stubEnv("CLERK_WEBHOOK_SECRET_2", secretOf([...shortKey, ...zeros(24 - shortKey.length)]));

        const res = await POST(signedRequest(JSON.stringify(EVENT), secretOf(shortKey)));

        expect(res.status).toBe(503);
        expect(mockDb.org.findUnique).not.toHaveBeenCalled();
        expect(mockMemory.ingest).not.toHaveBeenCalled();
      });

      it("refuses a key that is one byte repeated", async () => {
        const repeated = secretOf(new Array<number>(24).fill(0x01));
        vi.stubEnv("CLERK_WEBHOOK_SECRET_2", repeated);

        const res = await POST(signedRequest(JSON.stringify(EVENT), repeated));

        expect(res.status).toBe(503);
        expect(mockMemory.ingest).not.toHaveBeenCalled();
      });

      it("accepts a key with 16 key bytes before its trailing zeros", async () => {
        const sixteen = secretOf([...distinct(16), ...zeros(8)]);
        vi.stubEnv("CLERK_WEBHOOK_SECRET_2", sixteen);

        const res = await POST(signedRequest(JSON.stringify(EVENT), sixteen));

        expect(res.status).toBe(200);
        expect(mockMemory.ingest).toHaveBeenCalledTimes(1);
      });
    });

    it("fails closed: a valid first secret does not keep the endpoint open while the second is invalid", async () => {
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "whsec_abc");

      const res = await POST(signedRequest(JSON.stringify(EVENT), SECRET));

      expect(res.status).toBe(503);
      expect(mockMemory.ingest).not.toHaveBeenCalled();
    });

    it("names the invalid variable in the log and never its value", async () => {
      const invalid = `whsec_not-a-real-key-${"x".repeat(32)}`;
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", invalid);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      await POST(signedRequest(JSON.stringify(EVENT), SECRET));

      const logged = errors.mock.calls.flat().join(" ");
      expect(logged).toContain("CLERK_WEBHOOK_SECRET_2");
      expect(logged).not.toContain(invalid);
      expect(logged).not.toContain(SECRET);
    });
  });
});
