// List the mailbox connections that still hold a grant, ahead of revoking them.
// Read-only: it queries Integration rows and prints, writing nothing and calling
// no provider. Revoking an existing connection is a separate, deliberate step
// (disconnecting it, which runs DELETE /api/integrations/:id).
//
//   DATABASE_URL=<postgres url> npx tsx scripts/list-connected-mailboxes.ts
//
// Connections made before mailbox permissions were cut to identity only were
// granted Gmail read and send (or Outlook Mail.Read and Mail.Send), and may still
// have an inbox watch registered. Each line names the row by internal ids only,
// never the mailbox address, and says whether a recorded watch is still live.
import { pathToFileURL } from "node:url";

export interface MailboxRow {
  id: string;
  orgId: string;
  provider: string;
  createdAt: Date;
  meta: unknown;
}

/** When a watch recorded in `meta` expires, or null when none is recorded. */
export function watchExpiry(provider: string, meta: unknown): Date | null {
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as Record<string, unknown>;
  // Gmail stored the watch expiry as epoch milliseconds in a string; Outlook as ISO.
  const raw = provider === "gmail" ? record.gmailWatchExpires : record.outlookSubscriptionExpires;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const date = typeof raw === "number" || /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One line per connection, then a count line. */
export function describeMailboxes(rows: readonly MailboxRow[], now: Date): string[] {
  const lines = rows.map((row) => {
    const expiry = watchExpiry(row.provider, row.meta);
    const watch = !expiry
      ? "no watch recorded"
      : expiry > now
        ? `watch live until ${expiry.toISOString()}`
        : "watch expired";
    return `${row.provider}\t${row.id}\torg ${row.orgId}\tconnected since ${row.createdAt.toISOString()}\t${watch}`;
  });
  const live = rows.filter((row) => (watchExpiry(row.provider, row.meta) ?? now) > now).length;
  lines.push(`${rows.length} connected mailbox${rows.length === 1 ? "" : "es"}, ${live} with a live watch`);
  return lines;
}

async function main(): Promise<number> {
  if (process.argv.length > 2) throw new Error("this script takes no arguments; it only lists");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const { db } = await import("@/lib/db");
  try {
    const rows = await db.integration.findMany({
      where: { provider: { in: ["gmail", "outlook"] }, status: "connected", encryptedTokens: { not: null } },
      select: { id: true, orgId: true, provider: true, createdAt: true, meta: true },
      orderBy: { createdAt: "asc" },
    });
    console.log("list-connected-mailboxes: read-only, nothing is written or revoked");
    for (const line of describeMailboxes(rows, new Date())) console.log(line);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`list-connected-mailboxes: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
