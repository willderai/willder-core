// The invariant deny-reason.ts exists to hold: no builder may put a
// server-resolved scope path into the half a refused caller sees.
//
// This is a unit pin on the module, driven over every exported builder rather
// than over a list someone has to remember to extend — a new builder that
// interpolates the resolved path into `reason` fails here. The behavioural
// counterpart, through the real check() chain and the real MCP tool replies, is
// in mcp/tools.test.ts.
import { describe, expect, it } from "vitest";
import * as reasons from "./deny-reason";
import type { DecisionReasons } from "./deny-reason";

/** A target scope the server resolved, carrying a label no caller supplied. */
const SUBJECT_LABEL = "Northwind_Holdings";
const RESOLVED_SCOPE = `org_acme.${SUBJECT_LABEL}.detail`;

/**
 * Every builder, called with a resolved scope path wherever it takes one.
 * `callerSupplied` marks the builders whose arguments are all values the caller
 * sent, which are allowed to be quoted back verbatim; `noScope` marks those
 * that are not about a target scope at all.
 */
const CASES: { name: string; built: DecisionReasons; callerSupplied?: true; noScope?: true }[] = [
  { name: "humanGrantAllows", built: reasons.humanGrantAllows("read", RESOLVED_SCOPE) },
  { name: "noHumanGrant", built: reasons.noHumanGrant("read", "user_1", RESOLVED_SCOPE) },
  { name: "capabilityAllows", built: reasons.capabilityAllows("write", RESOLVED_SCOPE) },
  { name: "capabilityOwnerMismatch", built: reasons.capabilityOwnerMismatch("agent_other", "agent_1"), noScope: true },
  { name: "noCapability", built: reasons.noCapability("read", "agent_1", RESOLVED_SCOPE) },
  { name: "capabilityOutlivedGrant", built: reasons.capabilityOutlivedGrant("write", "agent_1", RESOLVED_SCOPE) },
  { name: "agentDeactivated", built: reasons.agentDeactivated("read", "agent_1", RESOLVED_SCOPE) },
  { name: "issuerLacksAccess", built: reasons.issuerLacksAccess("read", "agent_1", RESOLVED_SCOPE) },
  { name: "missingActorIdentity", built: reasons.missingActorIdentity("read", RESOLVED_SCOPE) },
  { name: "orgBeingDeleted", built: reasons.orgBeingDeleted("write", "human", RESOLVED_SCOPE) },
  { name: "invalidCallerScopePath", built: reasons.invalidCallerScopePath(RESOLVED_SCOPE), callerSupplied: true },
  {
    name: "unstorableTarget",
    built: reasons.unstorableTarget(reasons.noHumanGrant("read", "user_1", RESOLVED_SCOPE)),
  },
  {
    name: "partitionOutsideTenant",
    built: reasons.partitionOutsideTenant(RESOLVED_SCOPE, "acme"),
    callerSupplied: true,
  },
  { name: "groupIdOutsideTenant", built: reasons.groupIdOutsideTenant("acme", RESOLVED_SCOPE), callerSupplied: true },
  { name: "capabilityRefused", built: reasons.capabilityRefused("revoked"), noScope: true },
  { name: "orgRoleRequired", built: reasons.orgRoleRequired("member", ["owner", "admin"], RESOLVED_SCOPE) },
  { name: "operatorOrgRequired", built: reasons.operatorOrgRequired(RESOLVED_SCOPE) },
  { name: "restoreIncomplete", built: reasons.restoreIncomplete("read", RESOLVED_SCOPE) },
  {
    name: "wideningNotAcknowledged",
    built: reasons.wideningNotAcknowledged(
      { status: "known", people: 12, agents: 3 },
      { people: 12, agents: 3 },
      RESOLVED_SCOPE,
    ),
  },
  {
    name: "wideningAcknowledged",
    built: reasons.wideningAcknowledged(
      { status: "unknown", reason: "no sharing list", atMost: 4, agents: 1 },
      RESOLVED_SCOPE,
    ),
  },
];

describe("deny-reason builders", () => {
  it("covers every exported builder — a new one must be listed here", () => {
    const exported = Object.entries(reasons)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    expect(exported.sort()).toEqual(CASES.map((c) => c.name).sort());
  });

  for (const { name, built, callerSupplied, noScope } of CASES) {
    it(`${name}: the caller's half never names a server-resolved scope`, () => {
      if (callerSupplied) {
        // These quote only what the caller sent, which tells them nothing new.
        expect(built.reason).toContain(SUBJECT_LABEL);
      } else {
        expect(built.reason).not.toContain(SUBJECT_LABEL);
      }
    });

    it(`${name}: the operator's half keeps whatever the caller's half left out`, () => {
      expect(built.auditReason.length).toBeGreaterThan(0);
      if (!callerSupplied && !noScope) {
        expect(built.auditReason).toContain(SUBJECT_LABEL);
      }
    });
  }

  it("a refusal still names the missing permission and how to get it", () => {
    for (const built of [
      reasons.noHumanGrant("write", "user_1", RESOLVED_SCOPE),
      reasons.noCapability("read", "agent_1", RESOLVED_SCOPE),
      reasons.capabilityOutlivedGrant("admin", "agent_1", RESOLVED_SCOPE),
      reasons.agentDeactivated("read", "agent_1", RESOLVED_SCOPE),
      reasons.issuerLacksAccess("write", "agent_1", RESOLVED_SCOPE),
    ]) {
      expect(built.reason).toMatch(/read|write|admin/);
      expect(built.reason).toMatch(/ask an org admin/i);
    }
  });
});

// The widening sentence the person connecting reads (POST /api/sources 409
// `error`, and the audit row's reason). When the source cannot say who reads it
// and the scope has no other person, the people bound is 0, and the sentence
// used to read "may let up to 0 more people", which says "none" where the module
// rule is that unknown is never none (source-widening.ts). Seen on a local measure:
// GitHub private repo, weak token, atMost 0, agents 2.
// Only the text is pinned here; whether the connect is refused is decideWidening's
// and is not touched.
describe("widening sentence: an unknown people count is said as unknown, never 0", () => {
  const ROWS: {
    name: string;
    widening: Parameters<typeof reasons.wideningAcknowledged>[0];
    says: string[];
    never: RegExp[];
  }[] = [
    {
      name: "known counts (unchanged)",
      widening: { status: "known", people: 2, agents: 3 },
      says: ["This lets 2 more people and 3 agents read this source's content through Willder."],
      never: [/unknown/i],
    },
    {
      name: "unknown readers, a non-zero bound (unchanged)",
      widening: { status: "unknown", reason: "no sharing list", atMost: 4, agents: 1 },
      says: [
        "Willder cannot tell who can read this source at the source (no sharing list), " +
          "so connecting it may let up to 4 more people, and lets 1 agent read its content through Willder.",
      ],
      never: [],
    },
    {
      name: "unknown readers, bound 0, agents 2 (the private-repo case)",
      widening: {
        status: "unknown",
        reason: "GitHub does not tell a read-only token who can read a private repository",
        atMost: 0,
        agents: 2,
      },
      says: ["an unknown number of people", "2 agents"],
      never: [/\b0 more people\b/, /up to 0\b/],
    },
    {
      name: "unknown readers, bound 0, no agents",
      widening: { status: "unknown", reason: "no sharing list", atMost: 0, agents: 0 },
      says: ["an unknown number of people"],
      never: [/\b0 more people\b/, /up to 0\b/, /\b0 agents\b/],
    },
  ];

  for (const { name, widening, says, never } of ROWS) {
    it(name, () => {
      const acknowledge = {
        people: widening.status === "known" ? widening.people : ("unknown" as const),
        agents: widening.agents,
      };
      const refused = reasons.wideningNotAcknowledged(widening, acknowledge, RESOLVED_SCOPE);
      const acked = reasons.wideningAcknowledged(widening, RESOLVED_SCOPE);
      // The acknowledge JSON quoted in the refusal says "unknown" itself, so only
      // the sentence halves are read for `never`.
      for (const text of [refused.auditReason, acked.reason, acked.auditReason]) {
        for (const phrase of says) expect(text).toContain(phrase);
        for (const pattern of never) expect(text).not.toMatch(pattern);
      }
      for (const phrase of says) expect(refused.reason).toContain(phrase);
      expect(refused.reason).not.toMatch(/\b0 more people\b/);
    });
  }
});
