// Tier 1: Load known entities from Postgres — users, accounts, contacts, org.
// No LLM, no embeddings. O(1) lookups against CRM data the org already owns.
import { db } from "@/lib/db";
import { domainFromEmail, domainFromUrl } from "./normalize";
import type { KnownEntity } from "./types";

export async function loadStructuredEntities(orgId: string): Promise<KnownEntity[]> {
  const [users, accounts, contacts, org] = await Promise.all([
    db.user.findMany({
      where: { orgId },
      select: { id: true, name: true, email: true },
    }),
    db.account.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        domain: true,
        entityId: true,
        ownerId: true,
        owner: { select: { id: true, name: true } },
      },
    }),
    db.contact.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        email: true,
        title: true,
        entityId: true,
        account: { select: { name: true } },
      },
    }),
    db.org.findUnique({ where: { id: orgId }, select: { id: true, name: true } }),
  ]);

  const entities: KnownEntity[] = [];

  // ── Users ────────────────────────────────────────────────────────────────
  // canonical = full name; aliases = first name, email, email domain
  for (const u of users) {
    if (!u.name) continue;
    const aliases: string[] = [u.email];
    const firstName = u.name.split(" ")[0];
    if (firstName && firstName !== u.name) aliases.push(firstName);
    const domain = domainFromEmail(u.email);
    if (domain) aliases.push(domain);

    entities.push({ id: u.id, type: "user", canonicalName: u.name, aliases });
  }

  // ── Accounts ─────────────────────────────────────────────────────────────
  // canonical = name; aliases = domain variations, shortform, and account owner patterns
  for (const a of accounts) {
    if (!a.name) continue;
    const aliases: string[] = [];

    if (a.domain) {
      aliases.push(a.domain);
      aliases.push(`www.${a.domain}`);
      const d = domainFromUrl(a.domain);
      if (d && d !== a.domain) aliases.push(d);
    }

    // Shortform: "Acme Corporation" → also try "Acme"
    const words = a.name.split(" ");
    if (words.length > 1) aliases.push(words[0]);

    entities.push({ id: a.id, entityId: a.entityId, type: "account", canonicalName: a.name, aliases });

    // Account owner: if set, add "{AccountName}'s owner / account owner / AE" patterns
    // that map to the owner's canonical name. These are account-specific so we add them
    // as aliases on a synthetic KnownEntity for the owner, keyed by account context.
    if (a.owner?.name) {
      const ownerAliases = [
        `${a.name}'s owner`,
        `${a.name}'s account owner`,
        `${a.name}'s AE`,
        `${a.name}'s account executive`,
        `owner of ${a.name}`,
        `account owner of ${a.name}`,
      ];
      // Use the account id as a composite key to avoid dedup with the user entity
      entities.push({
        id: `${a.id}:owner`,
        type: "user",
        canonicalName: a.owner.name,
        aliases: ownerAliases,
      });
    }
  }

  // ── Contacts ─────────────────────────────────────────────────────────────
  // canonical = full name; aliases = first name, email, and title-at-account patterns
  for (const c of contacts) {
    if (!c.name) continue;
    const aliases: string[] = [];

    if (c.email) {
      aliases.push(c.email);
      const d = domainFromEmail(c.email);
      if (d) aliases.push(d);
    }

    // No first-name-only alias for contacts — too many people share common first
    // names (John, Mike, Sarah), causing false matches across unrelated contacts.

    // Title-at-account patterns: specific enough to be safe for deterministic pass
    // e.g. "VP of Sales at Acme Corp" → "Sarah Johnson"
    if (c.title && c.account?.name) {
      aliases.push(`${c.title} at ${c.account.name}`);
      aliases.push(`${c.account.name}'s ${c.title}`);
    }

    entities.push({ id: c.id, entityId: c.entityId, type: "contact", canonicalName: c.name, aliases });
  }

  // ── Org ──────────────────────────────────────────────────────────────────
  if (org) {
    entities.push({ id: org.id, type: "org", canonicalName: org.name, aliases: [] });
  }

  return entities;
}
