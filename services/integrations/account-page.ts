/**
 * One page of a provider's connected accounts for the Integrations page, and the
 * newest attempt in each other state, which a card shows while nothing is connected
 * and which tells a declined sign-in from a failed one.
 *
 * The one rule: the org and provider bound the rows, the counts and the attempts
 * alike, and no query here selects `encryptedTokens`.
 */
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { ACCOUNT_PAGE_SIZE, type AccountListQuery, type IntegrationProviderName } from "@/lib/integration-lists";
import { containsPattern, ilike, readSqlPage, sqlDirection } from "@/services/memory/sql-list-page";

/** An integration row as the cards read it: never its tokens. */
export type IntegrationRow = {
  id: string;
  provider: IntegrationProviderName;
  externalAccountId: string | null;
  status: "pending" | "connected" | "error" | "disconnected";
  meta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

const COLUMNS = {
  id: true,
  provider: true,
  externalAccountId: true,
  status: true,
  meta: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The name an account shows under: its mailbox address, its Slack workspace, else the provider's id. */
const ACCOUNT_NAME = Prisma.sql`COALESCE(i."meta"->>'email', i."meta"->>'teamName', i."externalAccountId", '')`;

/** Page `q.page` of the provider's connected accounts, with the matching and connected counts. */
export async function readConnectedAccountPage(orgId: string, provider: IntegrationProviderName, q: AccountListQuery) {
  const narrowed: Prisma.Sql[] = [];
  if (q.search !== "") {
    const p = containsPattern(q.search);
    narrowed.push(
      Prisma.sql`(${ilike(ACCOUNT_NAME, p)} OR ${ilike(Prisma.sql`COALESCE(i."externalAccountId", '')`, p)})`,
    );
  }
  const dir = sqlDirection(q.order);
  const key = q.sort === "account" ? Prisma.sql`lower(${ACCOUNT_NAME})` : Prisma.sql`i."createdAt"`;
  return readSqlPage<IntegrationRow>({
    select: Prisma.sql`i."id", i."provider"::text AS "provider", i."externalAccountId", i."status"::text AS "status",
      i."meta", i."createdAt", i."updatedAt"`,
    from: Prisma.sql`"integrations" i`,
    inOrg: Prisma.sql`i."orgId" = ${orgId} AND i."provider"::text = ${provider} AND i."status" = 'connected'`,
    narrowed,
    order: Prisma.sql`${key} ${dir}, i."id" ${dir}`,
    page: q.page,
    pageSize: ACCOUNT_PAGE_SIZE,
  });
}

/** The provider's newest pending, errored and disconnected rows, each null when there is none. */
export async function latestAttempts(orgId: string, provider: IntegrationProviderName) {
  const newest = (status: "pending" | "error" | "disconnected") =>
    db.integration.findFirst({
      where: { orgId, provider, status },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: COLUMNS,
    });
  const [pending, error, disconnected] = await Promise.all([
    newest("pending"),
    newest("error"),
    newest("disconnected"),
  ]);
  return { pending, error, disconnected };
}
