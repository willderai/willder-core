// Connecting a source can widen who reads its content.
//
// A connected source takes the access of the scope it lands in, not its own
// access list at the source. A Drive folder shared with two people, connected
// into a ten-person scope, is readable through Willder by ten, and by every agent
// holding a live capability token on that scope. This module measures that
// difference at connect time and decides whether the connect may go ahead
// without an explicit acknowledgement from the person connecting.
//
// The one rule it enforces: widening is never silent. A connect goes ahead
// unacknowledged only when the source reported its readers, every person who can
// read the scope is shown to read the source too, and no agent can read the
// scope. More readers, or a source that cannot say who reads it, needs an
// acknowledgement naming exactly what was shown, people and agents both.
// "Unknown" is never treated as "none".
//
// Agents are counted separately from people. An agent is not an account at the
// source, so no sharing list names one: every agent that can read the scope
// gains access, unless anyone at all can read the source.
//
// Identities are matched by email, and only by an email Clerk verified. A scope
// reader whose address is unverified, not yet known to be verified, or the
// no-email placeholder, or whom no source permission names, counts as widening.
// Matching errs towards warning, never towards a silent match.

import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import type { UserRole } from "@/types";
import type { Permission } from "./check";
import { memberGrantsSql } from "./member-grants";
import { flattenSql, scopeContainsSql } from "./scope-containment";

/** One entry of a source's own sharing list, as a connector reports it. */
export type SourceReader =
  /** Anyone can read it at the source, with no link needed: a public website or repository. */
  | { kind: "everyone" }
  /** One account, by its email address at the source. */
  | { kind: "email"; email: string }
  /** Every account whose email is at this domain, with no link needed. */
  | { kind: "domain"; domain: string }
  /** A reader no Willder person can be matched to: a group, a link-only share, a deleted account. */
  | { kind: "unmappable" };

/** What a connector can say about who reads a source at the source. */
export type SourceReaders =
  | { kind: "known"; readers: SourceReader[] }
  /** The connector cannot report readers. `reason` is shown to the person connecting. */
  | { kind: "unknown"; reason: string };

/** A person in the org who can read a scope, with the email used for matching. */
export interface ScopeReader {
  id: string;
  email: string;
  /** `User.emailVerified`: only `true` lets the email match a source reader. */
  emailVerified: boolean | null;
}

/** A person who can read a scope, as an admin listing names them. */
export interface ScopePerson extends ScopeReader {
  name: string | null;
  role: UserRole;
}

/** Who can read a scope through Willder: people by grant, agents by capability token. */
export interface ScopeAudience {
  people: ScopeReader[];
  /** Agent ids, each once. */
  agents: string[];
}

/**
 * How many more people, and how many agents, a connect lets read the source's
 * content than can read it at the source. `unknown` carries the number of other
 * people who can read the scope, the most the people widening can be; the agent
 * count is exact either way, since no agent reads at the source.
 */
export type Widening =
  | { status: "known"; people: number; agents: number }
  | { status: "unknown"; reason: string; atMost: number; agents: number };

/** Which path a connect took; recorded on the source row. */
type WideningPath = "no_widening" | "acknowledged" | "acknowledged_unknown";

/**
 * The value a caller sends as `acknowledgeWidening` to confirm a widening: both
 * counts exactly as the refusal named them, with `people: "unknown"` when the
 * source could not report its readers.
 */
export interface WideningAcknowledgement {
  people: number | "unknown";
  agents: number;
}

/**
 * The placeholder lib/tenant.ts stores for a user Clerk gave no email address.
 * It names no real account, so it can never match a source reader.
 */
const PLACEHOLDER_EMAIL_DOMAIN = "@no-email.local";

/** A live capability token that can read a scope. Never the token or its hash. */
export interface ScopeTokenReader {
  capabilityId: string;
  agentId: string;
  permission: Permission;
  expiresAt: Date;
}

/**
 * Every live capability token in the org that can read `scopePath`: not
 * revoked, not expired, its scope covering the target, at any permission (each
 * one covers read), its agent not deactivated (`Agent.active = false`, matched
 * by key or database id), and, for a grant-governed agent, still backed by one
 * of the agent's own grants that covers the scope. These are the rules check()
 * applies to the token (services/access/check.ts, loadMatchingCapabilities),
 * so a token listed here is one check() allows its agent to read with.
 */
export async function scopeTokenReaders(orgId: string, scopePath: string): Promise<ScopeTokenReader[]> {
  const tokenCovers = scopeContainsSql(Prisma.raw('c."scopePath"'), scopePath, { relation: "covers", mode: "ltree" });
  const grantCovers = scopeContainsSql(Prisma.raw('s."path"'), scopePath, { relation: "covers", mode: "ltree" });
  const query = Prisma.sql`
    SELECT c."id" AS "capabilityId", c."agentId", c."permission", c."expiresAt"
    FROM "capabilities" c
    WHERE c."orgId" = ${orgId}
      AND c."revokedAt" IS NULL
      AND c."expiresAt" > ${sqlUtcNow}
      AND ${tokenCovers}
      AND NOT EXISTS (
        SELECT 1 FROM "agents" a
        WHERE a."orgId" = c."orgId"
          AND (a."agentKey" = c."agentId" OR a."id" = c."agentId")
          AND a."active" = false
      )
      AND (
        c."grantGoverned" = false
        OR EXISTS (
          SELECT 1 FROM "grants" g
          JOIN "scopes" s ON s."id" = g."scopeId"
          WHERE g."orgId" = c."orgId"
            AND g."granteeType" = 'agent'
            AND g."granteeId" = c."agentId"
            AND (g."expiresAt" IS NULL OR g."expiresAt" > ${sqlUtcNow})
            AND ${grantCovers}
        )
      )
    ORDER BY c."agentId", c."expiresAt", c."id"
  `;
  return db.$queryRaw<ScopeTokenReader[]>(...flattenSql(query));
}

/** Every agent in the org that can read `scopePath`, each once: the agents of {@link scopeTokenReaders}. */
export async function scopeAgentReaders(orgId: string, scopePath: string): Promise<string[]> {
  const tokens = await scopeTokenReaders(orgId, scopePath);
  return [...new Set(tokens.map((token) => token.agentId))];
}

/** Everyone, people and agents, who can read `scopePath` through Willder. */
export async function scopeAudience(orgId: string, scopePath: string): Promise<ScopeAudience> {
  const [people, agents] = await Promise.all([scopeReaders(orgId, scopePath), scopeAgentReaders(orgId, scopePath)]);
  return { people, agents };
}

/**
 * Every person who can read `scopePath`: each live member of the org whom a
 * live grant to them, their role in the org, or everyone reaches there, at any
 * permission (each one covers read), named with their role in this org. It runs
 * the query check() decides a person's read with (services/access/member-grants.ts),
 * for every member at once, so the listing and the decision read the same
 * membership. Agents are counted by {@link scopeAgentReaders}.
 */
export async function scopeReaders(orgId: string, scopePath: string): Promise<ScopePerson[]> {
  const reach = memberGrantsSql(orgId, { covering: scopePath });
  const query = Prisma.sql`
    SELECT u."id", u."name", u."email", u."emailVerified", r."role"
    FROM "users" u
    JOIN (SELECT DISTINCT "userId", "role" FROM (${reach}) AS grants_reaching) r ON r."userId" = u."id"
    ORDER BY u."email", u."id"
  `;
  return db.$queryRaw<ScopePerson[]>(...flattenSql(query));
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * Whether the source's own sharing list is shown to include this person. An
 * address anyone could have typed in proves nothing, so an email Clerk has not
 * verified (false, or null for not yet known) never matches.
 */
function readsAtSource(person: ScopeReader, readers: SourceReader[]): boolean {
  if (person.emailVerified !== true) return false;
  const email = person.email.trim().toLowerCase();
  if (!email.includes("@") || email.endsWith(PLACEHOLDER_EMAIL_DOMAIN)) return false;
  return readers.some(
    (reader) =>
      (reader.kind === "email" && reader.email.trim().toLowerCase() === email) ||
      (reader.kind === "domain" && reader.domain.trim().toLowerCase() === domainOf(email)),
  );
}

/**
 * The widening a connect causes. The person connecting is left out: the
 * credential reading the source is theirs, so they read it there already.
 * Every agent counts unless anyone at all can read the source.
 */
export function computeWidening(
  scope: ScopeAudience,
  connectingUserId: string,
  readersOfSource: SourceReaders,
): Widening {
  const others = scope.people.filter((person) => person.id !== connectingUserId);
  const agents = new Set(scope.agents).size;
  if (readersOfSource.kind === "unknown") {
    return { status: "unknown", reason: readersOfSource.reason, atMost: others.length, agents };
  }
  if (readersOfSource.readers.some((reader) => reader.kind === "everyone")) {
    return { status: "known", people: 0, agents: 0 };
  }
  return {
    status: "known",
    people: others.filter((person) => !readsAtSource(person, readersOfSource.readers)).length,
    agents,
  };
}

/** The acknowledgement a widening needs, or null when it needs none. */
function requiredAcknowledgement(widening: Widening): WideningAcknowledgement | null {
  if (widening.status === "unknown") return { people: "unknown", agents: widening.agents };
  return widening.people > 0 || widening.agents > 0 ? { people: widening.people, agents: widening.agents } : null;
}

/** Whether `given` names exactly the counts in `needed`. */
function acknowledges(given: unknown, needed: WideningAcknowledgement): boolean {
  if (typeof given !== "object" || given === null) return false;
  const { people, agents } = given as Record<string, unknown>;
  return people === needed.people && agents === needed.agents;
}

/**
 * Whether a connect may go ahead, and on which path. `acknowledged` is the
 * caller's `acknowledgeWidening` value; it must name exactly what this connect
 * would do, people and agents both, so a confirmation given for different
 * numbers, or for a different kind of widening, does not carry over.
 */
export function decideWidening(
  widening: Widening,
  acknowledged: unknown,
): { proceed: true; path: WideningPath } | { proceed: false; acknowledge: WideningAcknowledgement } {
  const needed = requiredAcknowledgement(widening);
  if (needed === null) return { proceed: true, path: "no_widening" };
  if (!acknowledges(acknowledged, needed)) return { proceed: false, acknowledge: needed };
  return { proceed: true, path: needed.people === "unknown" ? "acknowledged_unknown" : "acknowledged" };
}
