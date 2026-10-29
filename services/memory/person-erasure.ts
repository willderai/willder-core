/**
 * Erasing one person from an org on request: the right-to-delete path.
 *
 * The rule this file enforces: one authorized request removes every copy of a
 * person this org holds — contact rows and their conversations, the frozen
 * copies in the contact idempotency ledger, vector chunks in every scope, the
 * person's graph nodes, episodes, verbatim facts and quoting summaries, the rules
 * (conventions and decisions) that name them, the aliases registered for them, and every
 * version written in place of one of those, whatever its own text says
 * (services/memory/erasure-lineage.ts, services/memory/erasure-rules.ts) — and touches
 * nothing in any other org. Only a caller with `access.manage` on
 * the org root may ask. The request is audited by id, never by the values it
 * erased: a `person.erased` row, written in the same transaction as the last
 * removal, carries how many records each store removed, counting what an earlier
 * attempt removed before it failed (services/memory/erasure-accounting.ts), and
 * nothing else.
 *
 * Order is what keeps a failed request retryable. The contact rows are how a
 * later call finds the person again, so they are removed last: the graph goes
 * first (the store most likely to fail), then the chunks, the change-feed
 * summaries, the rules, the versions written in place of what those steps removed,
 * and the briefs, each in its own step, then the working notes, the ledger, the alias
 * registry's rows and the contacts in one transaction.
 * Every step is idempotent, so a request that failed part-way is completed by
 * sending it again. A step scans the org outside any transaction (on a large org a
 * scan takes seconds, longer than a transaction may stay open), then removes what
 * it found in a short one. Each step puts the ids of the versions it removes on the
 * suppression list in that transaction, so a retry still finds what replaced them
 * after the text that named the person is gone.
 *
 * Content written while the request runs, after a step's scan, is found by the
 * last transaction: it checks again the chunks and briefs created since the
 * request started, the change events committed since the summaries were scanned,
 * and the versions written in place of a removed one since the replacements were
 * last looked for. A write that commits after the last transaction is a new act,
 * as after any finished erasure.
 *
 * How the person is matched, and why:
 *  - Contacts by id, by email (folded, as names are) or by graph entity id, then
 *    every other contact in the org with one of the emails or entity ids found.
 *  - Their aliases: the alias registry's rows for those contacts, or whose canonical name or
 *    one of whose aliases is one of their names or addresses (services/memory/entity-aliases.ts).
 *    The ingest resolver rewrites an alias to the canonical name in what it stores, so every
 *    name on such a row is one the org already reads as theirs, including the canonical name
 *    their own name was merged into: each one that is an address, or a name distinctive
 *    enough to match as text (below), is erased by as their own name or address is.
 *  - Text (chunk content, change summaries, briefs, working notes, a rule's subject and text, and in the
 *    graph episode bodies,
 *    verbatim facts, edges and summaries) by an email or a full name as a whole
 *    identifier, never inside a longer one (textPatterns): erasing "Al Li" leaves
 *    "Sal Lin" and "Al Liú", erasing dan@acme.com leaves jordan@acme.com. A name
 *    is found in text only given name first: read surname first, a list of people
 *    ("Wei Li, Ann Chen") or a name followed by another ("Li Ann Tan") would be erased
 *    as "Ann Li", so "Whitfield, Dana" in running text is missed instead.
 *  - Text also by a full name with its words joined by `_`, `.`, a hyphen or a camel-case
 *    step, as a file name or an address writes it ("Dana_Whitfield_offer.pdf",
 *    "DanaWhitfield offer.pdf"), and a record's name by her whole name written so
 *    ("dana_whitfield"); never inside a longer word ("Danaher"), joined by a hyphen to
 *    another ("Dana_Whitfield-Barnes_CV.pdf"), and never by hyphens alone where her own name
 *    has whitespace, as another person's double surname or compound given name is written
 *    ("dana-whitfield.pdf", "jean-pierre dupont"). Her whole name run together with nothing
 *    between its words, 6 characters or more ("danawhitfield"), or up to a hyphen of her own
 *    ("kimji-woo" for Kim Ji-woo), is hers too, digits before it or not ("2026danawhitfield").
 *    services/memory/person-name-characters.ts, joinedNamePattern, has the rule.
 *  - Every name also as ASCII spells it ("zoe ferrand" for "zoë ferrand"; asciiSpelling).
 *  - A record's own name (the entity a chunk is filed under, an episode's name, a graph
 *    entity's name) only by the person's whole name or address and nothing else
 *    (recordNamePatterns): a fact filed under "Mary Ann Li" or "Dana Whitfield
 *    Foundation" is another's, and goes only if its own text names the person.
 *  - Names, addresses and the text they are looked for in are compared folded
 *    (services/memory/person-name-characters.ts, foldName: letters Unicode assigned after 15.0
 *    read from one list whatever Unicode version ICU knows, NFKC, Unicode's lowercase under
 *    every database collation, "i" and a combining dot above (the Turkish "\u0130") as "i",
 *    NFC, a final sigma as "\u03c3", a curly apostrophe straight), so an accent typed as a separate combining mark ("Zoe\u0308") is
 *    the same letter as the precomposed one ("Zoë"), "Whit\ufb01eld" is "whitfield" and
 *    "DANA WH\u0130TF\u0130ELD" is "dana whitfield".
 *  - The person's graph entity also by its entity id. A one-word name is never matched
 *    at all, since one word names too many people; such a person is found by email and
 *    entity id only.
 *  - A stored version by what the change feed said of it: one whose announcement named
 *    the person (a Drive file named after them), and a fact a person corrected that was
 *    filed under them, whose correction's removal says "corrected: <their name>"
 *    (correctionSubjectPatterns). Then every version written in place of a removed one,
 *    which may name nobody: "Based in Denver", correcting a fact filed under the person.
 *  - Content that names the person only by phone number or nickname is not
 *    found.
 *
 * What keeps them gone afterwards:
 *  - Their emails, multi-word names and contact ids go on the org's suppression list
 *    first, before anything is removed, and every connector sync checks it before it
 *    writes (services/memory/erasure-suppression.ts). An unchanged source file
 *    is skipped by its checksum and was already erased; a changed one is
 *    checked again.
 *  - Connector records that point at an erased graph episode drop that
 *    pointer, so a later sync of the same file does not fail on retiring an
 *    episode that is already gone.
 *  - Change-feed summaries naming the person, and every summary about a version the
 *    request removed, are blanked; the events stay, so the feed keeps its order and a
 *    reader still learns the record changed.
 *  - Briefs naming the person, or citing a version the request removed, are deleted,
 *    each with a `delete` change event.
 *  - A claim whose touches (file paths) name the person keeps the claim with its touches emptied.
 *  - Working notes whose task or body names the person are deleted, each with a `delete`
 *    change event, as a release has: the note is gone from the task-start block, the
 *    Explore list and notices, and a later release of it finds nothing and writes no
 *    event. A post after the erasure that names the person is a new act.
 *  - Rules naming the person, and every rule version written in place of one, are redacted
 *    and retired, with the fact their text was also stored as
 *    (services/memory/erasure-rules.ts).
 *  - The ids of the versions it removed go on the suppression list, so a copy a
 *    restored backup puts back is never served, and re-applying erasures removes it.
 *  - An upload made before the erasure whose text is not extracted yet has no passage to
 *    find it by. Its extraction finds it instead: a passage naming the person is not stored,
 *    and the upload's raw file is deleted (lib/inngest/file-ingest.ts, storeFilePassages).
 *  - A connector listing a sync stored in Blob and has not deleted yet (a large GitHub or
 *    Slack listing; a run that died left it) is not searched for the person: every one
 *    in the org is deleted except the one its source's current run (`meta.syncRunId`)
 *    is still reading. A dead run's listing goes even when its source is syncing again
 *    (lib/source-listing-blobs.ts).
 *
 * Suite spec: docs/consent-deletion-suite.md, bar 3.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { dropIdleListings } from "@/lib/source-listing-blobs";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { AccessDeniedError, check, type AccessContext } from "@/services/access";
import { BRIEF_RECORD_TYPE } from "@/services/memory/create-brief";
import { FACT_RECORD_TYPE, recordChangeEvent } from "./change-events";
import {
  addCounts,
  NO_GRAPH_COUNTS,
  recordErasureCounts,
  recordErasureStep,
  unreportedSteps,
  type ErasureRequest,
  type ErasureStoreCounts,
} from "./erasure-accounting";
import { erasedVersionsAmong, firstSuppressedAt, markApplied, recordSuppressions } from "./erasure-suppression";
import {
  markVersionsErased,
  removeGraphCopies,
  removeVersions,
  replacementsToErase,
  storedCopiesOf,
} from "./erasure-lineage";
import { factCopiesOfRules, redactRules, rulesToRedact } from "./erasure-rules";
import { briefCorrectionNamePrefix, CORRECTED_FACT_PREFIX, CORRECTED_PREFIX } from "./correction-names";
import type { GraphPersonErasureResult } from "./graphiti-store";
import {
  asciiSpelling,
  CAMEL_STEP,
  CAMEL_STEP_AT,
  foldName,
  joinedNames,
  type JoinedName,
  joinedNamePattern,
  joinedRecordNamePattern,
  literal,
  NAME_END,
  NAME_SPACE,
  NAME_START,
  NEWER_COMPATIBILITY,
  NEWER_LETTERS,
} from "./person-name-characters";
import { graphitiStore } from "./store";
import { dropEpisodePointers } from "./episode-pointers";
import { deleteRemovedUploads, markUploadsNamingPerson, retirePassageEpisodes } from "./uploads";
import { lockAgentNotes, lockNoteDeletions, WORKING_NOTE_RECORD_TYPE } from "./working-notes";
import { CLAIM_OVERLAP_RECORD_TYPE } from "./claim-overlap";

/** Exactly one way to name the person to erase. */
export type PersonIdentifier = { contactId: string } | { email: string } | { entityId: string };

export interface PersonErasureResult {
  /** Matches the `person_erasure:<requestId>` audit row for this request. */
  requestId: string;
  contactsRemoved: number;
  snapshotsScrubbed: number;
  chunksRemoved: number;
  briefsRemoved: number;
  changeSummariesScrubbed: number;
  /** Versions removed because they were written in place of a removed version, whatever their text. */
  replacementsRemoved: number;
  /** Versions removed because their announcement on the change feed named the person. */
  announcedVersionsRemoved: number;
  /** Rule versions redacted and retired: those naming the person, and those written in place of one. */
  rulesRedacted: number;
  /** Working notes whose task or body named the person. */
  notesRemoved: number;
  /** A count the memory service did not report as a non-negative integer is absent. */
  graph: Partial<GraphPersonErasureResult>;
}

/** The request itself is malformed. Raised before any access decision. */
export class PersonErasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonErasureError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The identifiers one request erases by. Emails and names are folded (services/memory/person-name-characters.ts, foldName). */
interface ErasureTargets {
  contactIds: string[];
  emails: string[];
  names: string[];
  entityIds: string[];
  /** The alias registry's rows for the person, removed with their contacts. */
  aliasIds: string[];
}

/** A checked identifier: exactly one of these, trimmed, an email lowercased. */
export type ParsedPersonIdentifier = Partial<Record<"contactId" | "email" | "entityId", string>>;

/** An erasure `ctx` may run: its id, which its audit rows carry, and the person it names. */
interface AuthorizedPersonErasure {
  requestId: string;
  identifier: ParsedPersonIdentifier;
  /**
   * When the request was recorded, for a request run again under its own id
   * (services/memory/person-erasure-requests.ts): an earlier attempt's step rows are read from
   * then, so a retry for a person with no contact row still counts what that attempt removed.
   */
  requestedAt?: Date;
}

/**
 * Erase one person from `ctx.orgId`, in this call: {@link authorizePersonErasure}, then
 * {@link runPersonErasure}. POST /api/access/erasure runs the second half as a background job
 * instead (services/memory/person-erasure-requests.ts), because on a large org it takes longer
 * than an HTTP request may stay open.
 */
export async function erasePerson(ctx: AccessContext, identifier: PersonIdentifier): Promise<PersonErasureResult> {
  return runPersonErasure(ctx, await authorizePersonErasure(ctx, identifier));
}

/**
 * Check an erasure request before anything is removed. Throws PersonErasureError for a
 * malformed identifier, before any access decision, and AccessDeniedError without
 * `access.manage` on the org root; the decision is audited under the new request's id.
 */
export async function authorizePersonErasure(
  ctx: AccessContext,
  identifier: PersonIdentifier,
): Promise<AuthorizedPersonErasure> {
  const parsed = parseIdentifier(identifier);
  const requestId = randomUUID();
  const decision = await check(ctx, { action: "access.manage", target: `person_erasure:${requestId}` });
  if (!decision.allowed) throw new AccessDeniedError(decision);
  return { requestId, identifier: parsed };
}

/**
 * Erase the person an authorized request names. Throws whatever the graph store throws if it
 * cannot complete. A graph failure leaves Postgres with the person's suppression rows
 * recorded and the connector records' pointers to their episodes dropped, both of which a
 * retry needs anyway, and nothing else changed. Running it again with the same request
 * completes it.
 *
 * `finish` runs inside the last transaction, the one that writes the request's
 * `person.erased` row, with the result that row records: what it writes commits exactly
 * when the erasure does, and an error it throws undoes the last transaction.
 *
 * The counts returned are those of the request's `person.erased` row, including
 * what an earlier, unfinished attempt for the same contacts removed.
 */
export async function runPersonErasure(
  ctx: AccessContext,
  { requestId, identifier: seed, requestedAt }: AuthorizedPersonErasure,
  finish?: (tx: Prisma.TransactionClient, result: PersonErasureResult) => Promise<void>,
): Promise<PersonErasureResult> {
  const startedAt = requestedAt ?? (await databaseNow());
  const targets = await resolveTargets(ctx.orgId, seed);
  const request: ErasureRequest = { requestId, contactIds: targets.contactIds };

  // First, so a connector sync running while the rest is removed cannot write
  // the person back after their copy is gone.
  const listedAt = await recordSuppressions(db, ctx.orgId, requestId, targets);

  const hasText = targets.emails.length > 0 || targets.names.length > 0;
  const reachesGraph = hasText || targets.entityIds.length > 0;
  if (reachesGraph) await eraseFromGraph(ctx, request, targets);

  const patterns = textPatterns(targets);
  const scannedThrough = await lastChangeSeq(ctx.orgId);
  if (hasText) {
    // Before the chunks: a passage that names the person is how its upload is found.
    await removeUploads(ctx.orgId, targets, patterns);
    await removeChunks(ctx, request, targets);
    await scrubChangeSummaries(ctx, request, targets, patterns);
  }
  await eraseRules(ctx, request, hasText ? ruleNamesPerson(targets, patterns) : Prisma.sql`false`);
  await eraseReplacements(ctx, request);
  await removeBriefs(ctx, request, patterns);
  // Again, for a replacement committed while the steps above ran: its graph copy is removed
  // here; one committed after this is caught, without its graph copy, by the
  // last transaction.
  await eraseReplacements(ctx, request);

  const since = (await firstSuppressedAt(ctx.orgId, targets.contactIds)) ?? startedAt;
  const committed = await unreportedSteps(ctx.orgId, request, since);
  const result = await db.$transaction(async (tx) => {
    // First: a renewal holds its agent's note lock and its note's row before the org's
    // change-feed lock, so this transaction must take those before any change event here
    // takes that lock (deleteWorkingNotes).
    const notes = hasText ? await deleteWorkingNotes(tx, ctx, noteNamesPerson(patterns)) : 0;
    // A claim kept above can still name the person in a file path it touches.
    if (hasText) await clearWorkingNoteTouches(tx, ctx, touchesNamePerson(targets, patterns));
    if (hasText) await markUploadsNamingPerson(tx, ctx.orgId, uploadNamesPerson(targets, patterns));
    const late = await removeLateWrites(tx, ctx, request, targets, patterns, { startedAt, scannedThrough });
    const ledgerSnapshots = await scrubLedgerSnapshots(tx, ctx.orgId, targets);
    await tx.entityAlias.deleteMany({ where: { orgId: ctx.orgId, id: { in: targets.aliasIds } } });
    // Conversations and their messages cascade with the contact.
    const { count: contacts } = await tx.contact.deleteMany({
      where: { orgId: ctx.orgId, id: { in: targets.contactIds } },
    });
    const totals = addCounts(addCounts(committed.stores, late), {
      contacts: { contacts, ledgerSnapshots },
      notes: { notes },
      ...(reachesGraph ? {} : { graph: NO_GRAPH_COUNTS }),
    });
    await recordErasureCounts(tx, ctx, requestId, totals, committed.earlierRequestIds);
    // Only what this request removed: its own entries, an earlier unfinished attempt's for the
    // same contacts, and those for the person's values, whichever request listed them first;
    // never one another erasure of them has listed again since this one did (asOf).
    await markApplied(tx, ctx.orgId, `person_erasure:${requestId}`, {
      requestIds: [requestId, ...committed.earlierRequestIds],
      person: targets,
      asOf: listedAt,
    });
    const result = resultOf(requestId, totals);
    await finish?.(tx, result);
    return result;
  });

  // An upload made while the request ran was marked by the last transaction. The request is
  // complete without this delete: a marked upload is never served, and a blob left by a
  // failure here is deleted by the next removal in the org or by scripts/blob-orphans.ts.
  await deleteRemovedUploads(ctx.orgId).catch((e: unknown) =>
    console.error(`[erasure] ${requestId}: an upload's raw file is still to be deleted`, e),
  );
  // A connector listing a sync stored and has not deleted holds the source's text, which
  // may name the person, and is not searched: every one goes but the one its source's
  // current run is reading, so an older dead run's listing goes even on a syncing source
  // (lib/source-listing-blobs.ts). Like the upload delete, the request stands without it.
  await dropIdleListings(ctx.orgId).catch((e: unknown) =>
    console.error(`[erasure] ${requestId}: a stored connector listing is still to be deleted`, e),
  );

  return result;
}

/** The result a request reports: its `person.erased` row's totals, by the names the API gives them. */
function resultOf(requestId: string, totals: ErasureStoreCounts): PersonErasureResult {
  return {
    requestId,
    contactsRemoved: totals.contacts.contacts,
    snapshotsScrubbed: totals.contacts.ledgerSnapshots,
    chunksRemoved: totals.vector.chunks,
    briefsRemoved: totals.briefs.briefs,
    changeSummariesScrubbed: totals.changeFeed.summariesBlanked,
    replacementsRemoved: totals.lineage.replacements,
    announcedVersionsRemoved: totals.lineage.announced,
    rulesRedacted: totals.rules.rules,
    notesRemoved: totals.notes.notes,
    graph: totals.graph,
  };
}

/** The database's clock now, as UTC wall-clock time: the clock a chunk's `createdAt` is written by. */
async function databaseNow(): Promise<Date> {
  const [{ instant }] = await db.$queryRaw<{ instant: Date }[]>`SELECT ${sqlUtcNow} AS instant`;
  return instant;
}

/** `at` as a UTC timestamp without a zone, the way `createdAt` columns hold one. */
function utc(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** The org's latest change-feed `seq`. Feed order is commit order, so any event committed later has a higher one. */
async function lastChangeSeq(orgId: string): Promise<bigint> {
  const [{ seq }] = await db.$queryRaw<{ seq: bigint }[]>`
    SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM change_events WHERE "orgId" = ${orgId}
  `;
  return seq;
}

/**
 * Remove the person from the graph and drop the connector records' pointers to their
 * episodes. The pointers go first, from the graph's plan: once the episodes are gone a
 * repeat of the request finds none, so a failure between the erase and the drop would
 * leave a record pointing at an episode that no longer exists, and every later sync of
 * its file failing on it. Episodes the erase removed beyond the plan (written in between)
 * are dropped after it.
 */
async function eraseFromGraph(ctx: AccessContext, request: ErasureRequest, targets: ErasureTargets): Promise<void> {
  const input = { orgId: ctx.orgId, emails: targets.emails, names: targets.names, entityIds: targets.entityIds };
  const planned = await graphitiStore.planPersonErasure(input);
  // Marked erased before they go, so what replaced them is still found from them once the
  // graph no longer holds them (services/memory/erasure-lineage.ts).
  await db.$transaction(async (tx) => {
    const summariesBlanked = await markVersionsErased(tx, ctx.orgId, request.requestId, planned);
    await recordErasureStep(tx, ctx, request, { changeFeed: { summariesBlanked } });
  });
  await dropEpisodePointers(ctx.orgId, planned);
  const { episodeIds, ...graph } = await graphitiStore.erasePerson(input);
  await dropEpisodePointers(ctx.orgId, episodeIds);
  await db.$transaction(async (tx) => {
    const summariesBlanked = await markVersionsErased(tx, ctx.orgId, request.requestId, episodeIds);
    await recordErasureStep(tx, ctx, request, { graph, changeFeed: { summariesBlanked } });
  });
}

function parseIdentifier(identifier: PersonIdentifier): ParsedPersonIdentifier {
  const entries = Object.entries(identifier ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length !== 1) {
    throw new PersonErasureError("Name the person with exactly one of contactId, email or entityId.");
  }
  const [kind, raw] = entries[0];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (kind === "email") {
    if (value.length > 320 || !EMAIL_PATTERN.test(value)) {
      throw new PersonErasureError("email must be a single address like name@example.com.");
    }
    return { email: composed(value) };
  }
  if (kind === "contactId" || kind === "entityId") {
    if (!ID_PATTERN.test(value)) {
      throw new PersonErasureError(`${kind} must be 1 to 64 letters, digits, '-' or '_'.`);
    }
    return { [kind]: value };
  }
  throw new PersonErasureError("Name the person with exactly one of contactId, email or entityId.");
}

/** A name is safe to match as text only when it has at least two words and five
 *  characters, counted once composed: one word ("Cher", "Dana") names too many people
 *  to erase by. */
function isDistinctiveName(name: string): boolean {
  return name.split(/\s+/).filter(Boolean).length >= 2 && name.length >= 5;
}

/** A contact row as the erasure resolves a person from it. */
interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  entityId: string | null;
}

/**
 * The org's contacts with one of these ids or graph entity ids, or an address that folds to one
 * of `emails` (already folded, {@link composed}). Addresses are compared as {@link foldedText}
 * folds them, so "ZO\u00cb@ACME.EXAMPLE" is found for "zo\u00eb@acme.example" whatever the
 * database's collation, which a case-insensitive comparison would follow.
 */
function contactsMatching(
  orgId: string,
  { ids, emails, entityIds }: { ids: string[]; emails: string[]; entityIds: string[] },
): Promise<ContactRow[]> {
  return db.$queryRaw<ContactRow[]>`
    SELECT id, name, email, "entityId" FROM contacts
    WHERE "orgId" = ${orgId}
      AND (id = ANY (${ids}::text[])
        OR "entityId" = ANY (${entityIds}::text[])
        OR (email IS NOT NULL AND ${foldedText(Prisma.raw("email"))} = ANY (${emails}::text[])))`;
}

async function resolveTargets(orgId: string, seed: ParsedPersonIdentifier): Promise<ErasureTargets> {
  const direct = await contactsMatching(orgId, {
    ids: seed.contactId ? [seed.contactId] : [],
    emails: seed.email ? [seed.email] : [],
    entityIds: seed.entityId ? [seed.entityId] : [],
  });

  const emails = new Set<string>(seed.email ? [seed.email] : []);
  const entityIds = new Set<string>(seed.entityId ? [seed.entityId] : []);
  for (const c of direct) {
    if (c.email) emails.add(composed(c.email.trim()));
    if (c.entityId) entityIds.add(c.entityId);
  }

  // The same person under another contact row: same email or same entity.
  const related =
    emails.size || entityIds.size
      ? await contactsMatching(orgId, { ids: [], emails: [...emails], entityIds: [...entityIds] })
      : [];

  const contacts = new Map([...direct, ...related].map((c) => [c.id, c]));
  const contactIds = [...new Set([...(seed.contactId ? [seed.contactId] : []), ...contacts.keys()])].sort();
  const names = new Set([...contacts.values()].map((c) => nameKey(c.name)).filter(isDistinctiveName));
  const addresses = new Set([...emails].map(composed));

  // The registry is small and its names are free text, so it is read whole and matched here.
  const registry = await db.entityAlias.findMany({
    where: { orgId },
    select: { id: true, entityType: true, entityId: true, canonicalName: true, aliases: true },
  });
  const ownedIds = new Set(contactIds);
  const isTheirs = (value: string) => names.has(nameKey(value)) || addresses.has(nameKey(value));
  // A row matches by its canonical name (a name merged into theirs) or by one of its aliases
  // (their name merged into another): either way the resolver writes the row's canonical name
  // where they were meant, so every name on the row is read as theirs.
  const aliases = registry.filter(
    (row) =>
      (row.entityType === "contact" && ownedIds.has(row.entityId)) ||
      [row.canonicalName, ...row.aliases].some(isTheirs),
  );
  for (const value of aliases.flatMap((row) => [row.canonicalName, ...row.aliases])) {
    const key = nameKey(value);
    if (EMAIL_PATTERN.test(key)) addresses.add(key);
    else if (isDistinctiveName(key)) names.add(key);
  }
  // Each name as ASCII spells it is hers too ("zoe ferrand" for "zoë ferrand"): logins and file
  // names are mostly written so (services/memory/person-name-characters.ts, asciiSpelling).
  for (const name of [...names]) {
    const ascii = asciiSpelling(name);
    if (ascii && isDistinctiveName(ascii)) names.add(ascii);
  }

  return {
    contactIds,
    emails: [...addresses].sort(),
    names: [...names].sort(),
    entityIds: [...entityIds].sort(),
    aliasIds: aliases.map((row) => row.id).sort(),
  };
}

/** A name or address as a target holds it: trimmed, each run of whitespace one space, folded. */
function nameKey(value: string): string {
  return composed(value.trim().replace(/\s+/g, " "));
}

/** The form names, addresses and the text they are looked for in are compared in. */
const composed = foldName;

/** A name's words in order, separated by any run of whitespace. */
function spacedName(name: string): string {
  return name.split(" ").map(literal).join(`${NAME_SPACE}+`);
}

/**
 * A name as a record's whole name may hold it: {@link spacedName}, and a two-word name also
 * surname first, with or without a comma ("Whitfield, Dana", "Whitfield Dana"). The whole
 * field is the name, so the reversed order cannot be two people's words run together.
 */
function recordNameForms(name: string): string[] {
  const words = name.split(" ");
  const forms = [spacedName(name)];
  if (words.length === 2) forms.push(`${literal(words[1]!)}(,${NAME_SPACE}*|${NAME_SPACE}+)${literal(words[0]!)}`);
  return forms;
}

/**
 * The Postgres regular expressions that find the person in stored TEXT (content, change
 * summaries, briefs, citations), for {@link matchesText}. Each matches only a whole
 * identifier, so erasing "Al Li" never touches "Sal Lin" and erasing dan@acme.com never
 * touches jordan@acme.com:
 *  - a name, nothing that continues it into a longer word on either side ({@link NAME_START},
 *    {@link NAME_END}). Text that mentions her inside a longer phrase ("the Dana Whitfield
 *    Foundation", "the Dana Whitfield-approved budget", a "-Dana Whitfield" bullet) names
 *    her and matches; "Dana Whitfield-Barnes" is another person and does not. A surname
 *    with an honorific alone ("Ms. Whitfield") does not;
 *  - an address with nothing on its left that can belong to an address, and nothing on
 *    its right that would continue its domain, so a full stop ending a sentence is fine
 *    but al@acme.example.org is another address;
 *  - a name with its words joined by `_`, `.`, `-` or a camel-case step, as file names and
 *    addresses write it ("Dana_Whitfield_offer.pdf", "DanaWhitfield offer.pdf"), by
 *    services/memory/person-name-characters.ts, joinedNamePattern: `joined` against the text
 *    as {@link foldedText} holds it without any U+0001, `marked` against its {@link markedFolded}
 *    form.
 */
function textPatterns(targets: ErasureTargets): TextPatterns {
  const names = targets.names.map((name) => `${NAME_START}(${spacedName(name)})${NAME_END}`);
  const emails = targets.emails.map((email) => `(?<![a-z0-9._%+-])${literal(email)}(?![a-z0-9-])(?!\\.[a-z0-9-])`);
  return { spaced: [...emails, ...names], ...joinedForms(targets, joinedNamePattern) };
}

/** `pattern` for every target name that can be written without spaces, for folded text and for marked text. */
function joinedForms(
  targets: ErasureTargets,
  pattern: (name: JoinedName, form: { marked: boolean }) => string,
): Pick<TextPatterns, "joined" | "marked"> {
  const names = targets.names.flatMap(joinedNames);
  return {
    joined: names.map((n) => pattern(n, { marked: false })),
    marked: names.map((n) => pattern(n, { marked: true })),
  };
}

/**
 * The erasure's patterns for a column: `spaced` matched as {@link foldedText} holds it, `joined`
 * as it does without any U+0001, `marked` as {@link markedFolded} does.
 */
interface TextPatterns {
  spaced: string[];
  joined: string[];
  marked: string[];
}

/**
 * The Postgres regular expressions that match a record's NAME (the entity a chunk is filed
 * under) as the person's: her whole name and nothing else, however its words are spaced or
 * ordered, or her whole address. A record named "Mary Ann Li", "Ann Li Wei" or "Dana
 * Whitfield Foundation" is another person's or entity's, and is erased only if its own text
 * names her ({@link textPatterns}). Her whole name written without spaces is hers too
 * ("dana_whitfield", "DanaWhitfield"; joinedRecordNamePattern).
 */
function recordNamePatterns(targets: ErasureTargets): TextPatterns {
  const whole = (form: string) => `^${NAME_SPACE}*(${form})${NAME_SPACE}*$`;
  return {
    spaced: [...targets.emails.map(literal), ...targets.names.flatMap(recordNameForms)].map(whole),
    ...joinedForms(targets, joinedRecordNamePattern),
  };
}

/**
 * The collation text is lowercased under: ICU's root locale, which applies Unicode's own case
 * mapping, as JavaScript's toLowerCase does. Named in the query, so the result never depends on
 * the database's default collation: under "C", lower() changes ASCII letters only ("ZO\u00cb"
 * stays "zo\u00cb"), and a libc locale lowercases by its own tables. It needs a Postgres built
 * with ICU (the official images, Neon and Homebrew are); without it the erasure fails with
 * "collation does not exist" instead of matching less than it should.
 */
const UNICODE_CASE = Prisma.raw(`"und-x-icu"`);

/**
 * The letters Unicode assigned after 15.0 that the fold changes, as a bracket expression read
 * under "C" (services/memory/person-name-characters.ts, NEWER_LETTERS).
 */
const NEWER_LETTER_CLASS = `[${NEWER_LETTERS.letters}]`;

/** The listed letters that have a compatibility form (NEWER_COMPATIBILITY), the same way. */
const NEWER_COMPATIBLE_CLASS = `[${NEWER_COMPATIBILITY.letters}]`;

/**
 * `column` folded as {@link composed} folds text (services/memory/person-name-characters.ts,
 * foldName): a letter Unicode assigned after 15.0 read as its fold (NEWER_LETTERS), since ICU
 * and Postgres's own tables may know an older Unicode than JavaScript does; compatibility forms
 * folded (NFKC), lowercased by Unicode's mapping ({@link UNICODE_CASE}), "i" and a combining dot
 * above read as "i" (so "\u0130" is "i"), composed (NFC), "\u03c2" read as "\u03c3", a curly
 * apostrophe straight. The result is in the "C" collation, so it compares and matches by code point.
 * Normalizing a long text costs several times matching it, so it runs only where it can change
 * the result: text that is all ASCII is only lowercased, and text already folded but for its
 * case is only lowercased with its final sigmas read.
 */
export function foldedText(column: Prisma.Sql): Prisma.Sql {
  const text = Prisma.sql`(${column})`;
  const lowered = Prisma.sql`lower(${text} COLLATE ${UNICODE_CASE})`;
  const sigma = (folded: Prisma.Sql) => Prisma.sql`replace(${folded}, ${"\u03c2"}, ${"\u03c3"}) COLLATE "C"`;
  // translate() compares each character with every listed letter, so it runs only on text that holds one.
  const newerRead = Prisma.sql`(CASE WHEN ${text} COLLATE "C" ~ ${NEWER_LETTER_CLASS}
    THEN translate(${text}, ${NEWER_LETTERS.letters}, ${NEWER_LETTERS.folded}) ELSE ${text} END)`;
  return Prisma.sql`(CASE
    WHEN octet_length(${text}) = char_length(${text}) THEN lower(${text} COLLATE "C")
    WHEN ${text} IS NFKC NORMALIZED AND strpos(${text}, ${"\u0130"}) = 0 AND strpos(${text}, ${"\u2019"}) = 0
      AND strpos(${text}, ${"\u0307"}) = 0 AND ${text} COLLATE "C" !~ ${NEWER_LETTER_CLASS} AND ${lowered} IS NFC NORMALIZED
      THEN ${sigma(lowered)}
    ELSE replace(${sigma(Prisma.sql`normalize(replace(lower(normalize(${newerRead}, NFKC) COLLATE ${UNICODE_CASE}), ${"i\u0307"}, 'i'), NFC)`)},
      ${"\u2019"}, ${"'"}) END)`;
}

/**
 * `column` matched against `patterns` the same way under every collation: {@link foldedText},
 * then matched under C, where the classes above mean exactly the code points they list.
 */
function matchesAny(column: Prisma.Sql, patterns: string[]): Prisma.Sql {
  return Prisma.sql`${foldedText(column)} COLLATE "C" ~ ANY (${patterns}::text[])`;
}

/**
 * `column` as services/memory/person-name-characters.ts, markWordSteps, reads it (compatibility
 * forms folded first, any U+0001 dropped, "%20" a space, "%27" and "%E2%80%99" an apostrophe, each camel-case
 * step marked), then
 * {@link foldedText}: the form `marked` patterns are matched in, as
 * services/memory/erasure-suppression.ts reads text before it hashes it. The steps are found
 * under C, so the classes mean the code points they list; the marked text is then folded as
 * {@link foldedText} folds a column, whatever the database's collation. Computed once per row.
 */
function markedFolded(column: Prisma.Sql): Prisma.Sql {
  // The listed letters with a compatibility form take it first, in their own case, whatever
  // Unicode version Postgres's tables know (services/memory/person-name-characters.ts, compatibilityFolded).
  const compatible = Prisma.sql`${column} COLLATE "C" ~ ${NEWER_COMPATIBLE_CLASS}`;
  const nfkc = Prisma.sql`(CASE WHEN octet_length(${column}) = char_length(${column}) OR (${column} IS NFKC NORMALIZED AND NOT ${compatible})
    THEN ${column}
    WHEN ${compatible} THEN normalize(translate(${column}, ${NEWER_COMPATIBILITY.letters}, ${NEWER_COMPATIBILITY.forms}), NFKC)
    ELSE normalize(${column}, NFKC) END)`;
  const spaced = Prisma.sql`replace(replace(${nfkc}, ${CAMEL_STEP}, ''), '%20', ' ')`;
  const steps = Prisma.sql`replace(replace(replace(${spaced}, '%27', ''''), '%E2%80%99', ''''), '%e2%80%99', '''') COLLATE "C"`;
  return Prisma.sql`(SELECT ${foldedText(Prisma.raw("m"))}
    FROM (SELECT regexp_replace(${steps}, ${CAMEL_STEP_AT}, ${`\\1\\2${CAMEL_STEP}`}, 'g') AS m) AS marked)`;
}

/**
 * Whether `column` names the person: {@link matchesAny} for its `spaced` patterns, its
 * {@link foldedText} form without any U+0001 for `joined`, and its {@link markedFolded} form for
 * `marked`.
 */
function matchesText(column: Prisma.Sql, patterns: TextPatterns): Prisma.Sql {
  const asWritten = matchesAny(column, patterns.spaced);
  if (patterns.marked.length === 0) return asWritten;
  return Prisma.sql`(${asWritten}
    OR replace(${foldedText(column)}, ${CAMEL_STEP}, '') COLLATE "C" ~ ANY (${patterns.joined}::text[])
    OR ${markedFolded(column)} COLLATE "C" ~ ANY (${patterns.marked}::text[]))`;
}

/**
 * Clear the session key of every change event in the org whose key names the person, or of
 * those after `afterSeq` only: by the text patterns, and by the record-name patterns a filename
 * or an entity name is matched by, so a key that writes the name as a record would ("Brennick,
 * Orla") is cleared too. The key only links a claim to the run its own session captured
 * (services/memory/claim-status.ts), so a cleared one leaves that claim proposed, never wrongly tested.
 */
async function clearSessionKeysNaming(
  tx: Prisma.TransactionClient,
  orgId: string,
  targets: ErasureTargets,
  patterns: TextPatterns,
  afterSeq?: bigint,
): Promise<void> {
  const key = Prisma.raw('"sessionKey"');
  await tx.$executeRaw`
    UPDATE change_events SET "sessionKey" = NULL
    WHERE "orgId" = ${orgId} AND "sessionKey" IS NOT NULL
      ${afterSeq === undefined ? Prisma.empty : Prisma.sql`AND seq > ${afterSeq}`}
      AND (${matchesText(key, patterns)} OR ${matchesText(key, recordNamePatterns(targets))})
  `;
}

/** Whether a chunk names the person: in its text, or as the entity it is filed under. */
function chunkNamesPerson(targets: ErasureTargets, patterns: TextPatterns): Prisma.Sql {
  return Prisma.sql`(${matchesText(Prisma.raw("content"), patterns)} OR ${matchesText(Prisma.raw('"entityName"'), recordNamePatterns(targets))})`;
}

/** The erasure's text match over an upload: by its filename, or by one of its passages. */
function uploadNamesPerson(targets: ErasureTargets, patterns: TextPatterns) {
  return {
    filenameNamesPerson: Prisma.sql`(${matchesText(Prisma.raw("filename"), patterns)} OR ${matchesText(Prisma.raw("filename"), recordNamePatterns(targets))})`,
    passageNamesPerson: chunkNamesPerson(targets, patterns),
  };
}

/**
 * Remove every upload in the org that names the person, by filename or in one of its
 * passages: the raw file and its record (services/memory/uploads.ts). Its passages go with
 * the chunks in the next step, those that name the person. Marked in one transaction, so a
 * request that fails after it still deletes the file when sent again, even once the
 * passage that found it is gone.
 */
async function removeUploads(orgId: string, targets: ErasureTargets, patterns: TextPatterns): Promise<void> {
  await db.$transaction((tx) => markUploadsNamingPerson(tx, orgId, uploadNamesPerson(targets, patterns)));
  await deleteRemovedUploads(orgId);
}

/**
 * Delete every chunk in the org, in any scope or none, that names the person: in its
 * text, or as the entity it is filed under. memory_ingest stores a fact under the entity
 * it is about, so a fact about the person can say only "She ..." and still be theirs;
 * memory_version returns that name with it. Each one is marked erased by its id, which
 * blanks every change event about it, among them a summary that names the person only by
 * an alias the entity resolver rewrote in the stored text.
 */
async function removeChunks(ctx: AccessContext, request: ErasureRequest, targets: ErasureTargets): Promise<void> {
  const namesPerson = chunkNamesPerson(targets, textPatterns(targets));
  const found = await db.$queryRaw<{ id: string; scopePath: string | null }[]>`
    SELECT id, "scopePath"::text AS "scopePath" FROM memory_chunks WHERE "orgId" = ${ctx.orgId} AND ${namesPerson}
  `;
  // What the graph distilled from a chunk need not name the person ("Moved to Denver"), so
  // the graph's own text match can miss it. Every write stamps its episodes with the chunk's
  // id, so they go by it, before the chunk, so a graph failure leaves the chunk for a retry
  // to find.
  await retirePassageEpisodes(ctx.orgId, found);
  await db.$transaction(async (tx) => {
    const removed = await tx.$queryRaw<{ id: string }[]>`
      DELETE FROM memory_chunks
      WHERE "orgId" = ${ctx.orgId} AND id = ANY (${found.map((c) => c.id)}::text[]) AND ${namesPerson}
      RETURNING id
    `;
    const summariesBlanked = await markVersionsErased(
      tx,
      ctx.orgId,
      request.requestId,
      removed.map((c) => c.id),
    );
    await recordErasureStep(tx, ctx, request, { vector: { chunks: removed.length }, changeFeed: { summariesBlanked } });
  });
}

/**
 * The Postgres regular expressions that match a correction's `supersede` summary when the fact
 * it removed was filed under the person: "corrected: " and their whole name or address, as
 * {@link recordNamePatterns} matches a record's name (services/memory/correction-names.ts,
 * `correctionTitle`). A correction of a fact filed under "Dana Whitfield Foundation" is not one.
 */
function correctionSubjectPatterns(targets: ErasureTargets): string[] {
  const prefix = literal(CORRECTED_PREFIX);
  const whole = (form: string) => `^${prefix}${NAME_SPACE}*(${form})${NAME_SPACE}*$`;
  return [...targets.emails.map(literal), ...targets.names.flatMap(recordNameForms)].map(whole);
}

/**
 * Whether a change event is a correction's `supersede` of a fact about the person: one filed
 * under them ({@link correctionSubjectPatterns}), or a graph fact whose text names them.
 */
function correctsTheirs(subjects: string[], patterns: TextPatterns): Prisma.Sql {
  return Prisma.sql`(op = 'supersede' AND (${matchesAny(Prisma.raw("summary"), subjects)}
    OR (starts_with(summary, ${CORRECTED_FACT_PREFIX}) AND ${matchesText(Prisma.raw("summary"), patterns)})))`;
}

/** A change event found naming the person, with the version it is about. */
interface NamingEvent {
  id: string;
  recordType: string;
  recordId: string;
  op: string;
  /** Whether it is a correction's `supersede` of a fact about the person. */
  correctsTheirs: boolean;
}

/**
 * The fact versions `events` say were the person's: those whose own announcement (their
 * `create` or `update`) named them, and those a person corrected that were about them.
 * Either may be gone already, a corrected fact always is; what replaced it is still found from
 * its id (services/memory/erasure-lineage.ts).
 */
function versionsNamedBy(events: NamingEvent[]): { announced: string[]; corrected: string[] } {
  const facts = events.filter((e) => e.recordType === FACT_RECORD_TYPE);
  return {
    announced: [...new Set(facts.filter((e) => e.op === "create" || e.op === "update").map((e) => e.recordId))],
    corrected: [...new Set(facts.filter((e) => e.correctsTheirs).map((e) => e.recordId))],
  };
}

/**
 * Blank the summary of every change event in the org that names the person.
 * The event itself stays: its `seq` is part of the feed's commit order, and a
 * reader is still owed the news that the record changed.
 *
 * A fact version whose announcement named them is removed too, with what is still stored of
 * it: for a connector item, a Drive file named after them, whose passages need not name them.
 * Chunk rows are not affected in practice, since a chunk's text holds its announcement's. A
 * fact a person corrected that was filed under them is gone already; it is marked erased, so
 * its correction is removed as its replacement.
 *
 * An event's session key is a label its writer's client chose, so it can name the person too;
 * one that does is cleared ({@link clearSessionKeysNaming}).
 */
async function scrubChangeSummaries(
  ctx: AccessContext,
  request: ErasureRequest,
  targets: ErasureTargets,
  patterns: TextPatterns,
): Promise<void> {
  const subjects = correctionSubjectPatterns(targets);
  const namesPerson = Prisma.sql`(${matchesText(Prisma.raw("summary"), patterns)} OR ${matchesAny(Prisma.raw("summary"), subjects)} OR ${overlapSummaryNamesPerson(targets, patterns)})`;
  const found = await db.$queryRaw<NamingEvent[]>`
    SELECT id, "recordType", "recordId", op::text AS op, ${correctsTheirs(subjects, patterns)} AS "correctsTheirs"
    FROM change_events WHERE "orgId" = ${ctx.orgId} AND ${namesPerson}
  `;
  const { announced, corrected } = versionsNamedBy(found);
  const copies = await storedCopiesOf(ctx.orgId, announced);
  const graph = await removeGraphCopies(ctx.orgId, copies);
  await db.$transaction(async (tx) => {
    const blanked = await tx.$executeRaw`
      UPDATE change_events SET summary = ''
      WHERE "orgId" = ${ctx.orgId} AND id = ANY (${found.map((e) => e.id)}::text[]) AND ${namesPerson}
    `;
    await clearSessionKeysNaming(tx, ctx.orgId, targets, patterns);
    const removed = await removeVersions(tx, ctx.orgId, request.requestId, announced, copies);
    const marked = await markVersionsErased(tx, ctx.orgId, request.requestId, corrected);
    await recordErasureStep(tx, ctx, request, {
      graph,
      vector: { chunks: removed.chunks },
      changeFeed: { summariesBlanked: blanked + removed.summariesBlanked + marked },
      lineage: { replacements: 0, announced: copies.chunks.length + copies.items.length },
    });
  });
}

/**
 * Whether a rule names the person: in its subject or text as {@link textPatterns} finds a name
 * in text, or with a subject that is their whole name or address, as a record's own name
 * ({@link recordNamePatterns}): a rule about "Whitfield, Dana" is hers.
 */
function ruleNamesPerson(targets: ErasureTargets, patterns: TextPatterns): Prisma.Sql {
  return Prisma.sql`(${matchesText(Prisma.raw("subject"), patterns)} OR ${matchesText(Prisma.raw("text"), patterns)}
    OR ${matchesText(Prisma.raw("subject"), recordNamePatterns(targets))})`;
}

/**
 * Redact every rule `namesPerson` matches and every rule version written in place of one, with
 * the facts their text was stored as: those facts' graph copies first, then, in one transaction,
 * the rules and the facts' rows (services/memory/erasure-rules.ts). A fact removed here is
 * marked erased, so what was written in place of it goes in the replacements step after this.
 */
async function eraseRules(ctx: AccessContext, request: ErasureRequest, namesPerson: Prisma.Sql): Promise<void> {
  const rules = await rulesToRedact(db, ctx.orgId, namesPerson);
  if (rules.length === 0) return;
  const facts = await factCopiesOfRules(db, ctx.orgId, rules);
  const copies = await storedCopiesOf(ctx.orgId, facts);
  const graph = await removeGraphCopies(ctx.orgId, copies);
  await db.$transaction(async (tx) => {
    const redacted = await redactRules(tx, ctx, request.requestId, rules);
    const removed = await removeVersions(tx, ctx.orgId, request.requestId, facts, copies);
    await recordErasureStep(tx, ctx, request, {
      graph,
      rules: { rules: redacted.rules },
      vector: { chunks: removed.chunks },
      changeFeed: { summariesBlanked: redacted.summariesBlanked + removed.summariesBlanked },
    });
  });
}

/**
 * Remove every version written in place of a version an erasure removed, with its graph copy
 * first, then its rows, in one transaction that marks each erased
 * (services/memory/erasure-lineage.ts). A version an erasure already removed is not removed
 * twice, so running this again removes only replacements committed since.
 */
async function eraseReplacements(ctx: AccessContext, request: ErasureRequest): Promise<void> {
  const replacements = await replacementsToErase(db, ctx.orgId);
  if (replacements.length === 0) return;
  const copies = await storedCopiesOf(ctx.orgId, replacements);
  const graph = await removeGraphCopies(ctx.orgId, copies);
  await db.$transaction(async (tx) => {
    const removed = await removeVersions(tx, ctx.orgId, request.requestId, replacements, copies);
    await recordErasureStep(tx, ctx, request, {
      graph,
      vector: { chunks: removed.chunks },
      changeFeed: { summariesBlanked: removed.summariesBlanked },
      lineage: { replacements: replacements.length, announced: 0 },
    });
  });
}

/**
 * Whether a brief names the person: in its text, or in the text of a fact it cited. A
 * citation is a stored copy of a fact (`brief_citations`), so a brief that paraphrased
 * the person away still goes when a fact it quoted named them. A brief that cited a version
 * the erasure removed (`erasedCitations`) is built from it, and goes whatever its text says.
 */
function briefNamesPerson(patterns: TextPatterns, erasedCitations: string[]): Prisma.Sql {
  return Prisma.sql`(
    ${matchesText(
      Prisma.raw(`concat_ws(chr(10), title, summary, sections::text, diagram, "granteeName", "granteeRole",
              milestones::text, charts::text, decisions::text)`),
      patterns,
    )}
    OR EXISTS (
      SELECT 1 FROM brief_citations c
      WHERE c."briefId" = briefs.id
        AND (${matchesText(Prisma.raw('c."factText"'), patterns)} OR c."factId" = ANY (${erasedCitations}::text[]))
    )
  )`;
}

/**
 * The fact versions briefs in the org cite that an erasure removed: a version's id goes on the
 * suppression list when it is removed, so this holds after the version and the text that named
 * the person are gone.
 */
async function erasedCitations(reader: Prisma.TransactionClient | typeof db, orgId: string): Promise<string[]> {
  const cited = await reader.$queryRaw<{ factId: string }[]>`
    SELECT DISTINCT c."factId" FROM brief_citations c JOIN briefs b ON b.id = c."briefId" WHERE b."orgId" = ${orgId}
  `;
  return [
    ...(await erasedVersionsAmong(
      reader,
      orgId,
      cited.map((c) => c.factId),
    )),
  ];
}

/**
 * Delete every brief in the org that names the person or cites a version an erasure removed,
 * announcing each deletion on the change feed, and every correction a person made to one of
 * them: a correction of a brief that named the person is filed under the brief's id, not the
 * person, and its text need not name them ("She moved to Denver"). Their graph copies go first,
 * by the corrections' names, which only corrections of the deleted brief carry.
 */
async function removeBriefs(ctx: AccessContext, request: ErasureRequest, patterns: TextPatterns): Promise<void> {
  const namesPerson = briefNamesPerson(patterns, await erasedCitations(db, ctx.orgId));
  const found = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM briefs WHERE "orgId" = ${ctx.orgId} AND ${namesPerson}
  `;
  const corrections = await correctionsOfBriefs(
    db,
    ctx.orgId,
    found.map((b) => b.id),
  );
  const copies = await storedCopiesOf(
    ctx.orgId,
    corrections.map((c) => c.id),
  );
  const graph = await removeGraphCopies(ctx.orgId, copies, { ownedNames: corrections.map((c) => c.entityName) });
  await db.$transaction(async (tx) => {
    const briefs = await deleteBriefs(
      tx,
      ctx,
      found.map((b) => b.id),
      namesPerson,
    );
    const removed = await removeVersions(
      tx,
      ctx.orgId,
      request.requestId,
      corrections.map((c) => c.id),
      copies,
    );
    await recordErasureStep(tx, ctx, request, {
      graph,
      briefs: { briefs },
      vector: { chunks: removed.chunks },
      changeFeed: { summariesBlanked: removed.summariesBlanked },
    });
  });
}

/** The stored corrections people made to briefs `briefIds`, by the name every one is filed under. */
async function correctionsOfBriefs(
  reader: Prisma.TransactionClient | typeof db,
  orgId: string,
  briefIds: string[],
): Promise<{ id: string; entityName: string }[]> {
  if (briefIds.length === 0) return [];
  return reader.$queryRaw<{ id: string; entityName: string }[]>`
    SELECT c.id, c."entityName" FROM memory_chunks c
    WHERE c."orgId" = ${orgId}
      AND EXISTS (SELECT 1 FROM unnest(${briefIds.map(briefCorrectionNamePrefix)}::text[]) AS p(prefix) WHERE starts_with(c."entityName", p.prefix))
  `;
}

/**
 * Inside the last transaction, remove what was written naming the person after the
 * steps above scanned for it: chunks and briefs created since the request started
 * (neither is edited in place), and change events committed since the summaries were
 * scanned. Each is a handful of rows, found without matching the rest of the org.
 * A brief's `createdAt` comes from the app server's clock, not the database's: a
 * server running behind it can make a brief written in that gap read as older than
 * the request, and that brief is missed.
 *
 * So are rules written naming the person since the request started, and rule versions
 * written in place of a redacted one since the rules step; and what was written in place
 * of a removed version since the last pass for replacements: its row and the text of its events go, and it is marked erased, but its
 * graph copy, which the memory service holds outside this transaction, stays. The same
 * holds for a connector item whose announcement named the person in that window.
 */
async function removeLateWrites(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  request: ErasureRequest,
  targets: ErasureTargets,
  patterns: TextPatterns,
  { startedAt, scannedThrough }: { startedAt: Date; scannedThrough: bigint },
): Promise<Partial<ErasureStoreCounts>> {
  const lateChunks = await tx.$queryRaw<{ id: string }[]>`
    DELETE FROM memory_chunks
    WHERE "orgId" = ${ctx.orgId} AND "createdAt" >= ${utc(startedAt)} AND ${chunkNamesPerson(targets, patterns)}
    RETURNING id
  `;
  let summariesBlanked = await markVersionsErased(
    tx,
    ctx.orgId,
    request.requestId,
    lateChunks.map((c) => c.id),
  );

  const subjects = correctionSubjectPatterns(targets);
  const namesPerson = Prisma.sql`(${matchesText(Prisma.raw("summary"), patterns)} OR ${matchesAny(Prisma.raw("summary"), subjects)} OR ${overlapSummaryNamesPerson(targets, patterns)})`;
  const lateEvents = await tx.$queryRaw<NamingEvent[]>`
    SELECT id, "recordType", "recordId", op::text AS op, ${correctsTheirs(subjects, patterns)} AS "correctsTheirs"
    FROM change_events
    WHERE "orgId" = ${ctx.orgId} AND seq > ${scannedThrough} AND ${namesPerson}
  `;
  summariesBlanked += await tx.$executeRaw`
    UPDATE change_events SET summary = '' WHERE "orgId" = ${ctx.orgId} AND id = ANY (${lateEvents.map((e) => e.id)}::text[])
  `;
  await clearSessionKeysNaming(tx, ctx.orgId, targets, patterns, scannedThrough);
  const { announced, corrected } = versionsNamedBy(lateEvents);
  const announcedCopies = await storedCopiesOf(ctx.orgId, announced, tx);
  const lateAnnounced = await removeVersions(tx, ctx.orgId, request.requestId, announced, announcedCopies);
  summariesBlanked +=
    lateAnnounced.summariesBlanked + (await markVersionsErased(tx, ctx.orgId, request.requestId, corrected));

  // Rules written naming the person since the request started, and rule versions written in
  // place of a redacted one since the rules step: their facts' rows go, their graph copies stay.
  const hasText = targets.emails.length > 0 || targets.names.length > 0;
  const lateRuleNames = hasText
    ? Prisma.sql`("createdAt" >= ${utc(startedAt)} AND ${ruleNamesPerson(targets, patterns)})`
    : Prisma.sql`false`;
  const lateRules = await rulesToRedact(tx, ctx.orgId, lateRuleNames);
  const lateRuleFacts = await factCopiesOfRules(tx, ctx.orgId, lateRules);
  const redacted = await redactRules(tx, ctx, request.requestId, lateRules);
  const lateRuleCopies = await removeVersions(
    tx,
    ctx.orgId,
    request.requestId,
    lateRuleFacts,
    await storedCopiesOf(ctx.orgId, lateRuleFacts, tx),
  );
  summariesBlanked += redacted.summariesBlanked + lateRuleCopies.summariesBlanked;

  const replacements = await replacementsToErase(tx, ctx.orgId);
  const lateReplaced = await removeVersions(
    tx,
    ctx.orgId,
    request.requestId,
    replacements,
    await storedCopiesOf(ctx.orgId, replacements, tx),
  );
  summariesBlanked += lateReplaced.summariesBlanked;

  const namesPersonOrCitesErased = briefNamesPerson(patterns, await erasedCitations(tx, ctx.orgId));
  const late = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM briefs WHERE "orgId" = ${ctx.orgId} AND "createdAt" >= ${utc(startedAt)}
  `;
  const briefs = await deleteBriefs(
    tx,
    ctx,
    late.map((b) => b.id),
    namesPersonOrCitesErased,
  );
  return {
    vector: { chunks: lateChunks.length + lateAnnounced.chunks + lateReplaced.chunks + lateRuleCopies.chunks },
    changeFeed: { summariesBlanked },
    briefs: { briefs },
    rules: { rules: redacted.rules },
    lineage: {
      replacements: replacements.length,
      announced: announcedCopies.chunks.length + announcedCopies.items.length,
    },
  };
}

/**
 * Delete those of `ids` that still name the person, each with a `delete` change event.
 * Re-applying erasures after a restore (services/memory/erasure-reapply.ts) passes `true`
 * as `namesPerson`, having judged the restored briefs itself.
 */
export async function deleteBriefs(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  ids: string[],
  namesPerson: Prisma.Sql,
): Promise<number> {
  const removed = await tx.$queryRaw<{ id: string; scopePath: string }[]>`
    DELETE FROM briefs
    WHERE "orgId" = ${ctx.orgId} AND id = ANY (${ids}::text[]) AND ${namesPerson}
    RETURNING id, "scopePath"
  `;
  for (const brief of removed) {
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: brief.scopePath,
      recordType: BRIEF_RECORD_TYPE,
      recordId: brief.id,
      op: "delete",
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      title: "",
    });
  }
  return removed.length;
}

/** Whether a working note names the person, in its task or its body. */
function noteNamesPerson(patterns: TextPatterns): Prisma.Sql {
  return Prisma.sql`(${matchesText(Prisma.raw("task"), patterns)} OR ${matchesText(Prisma.raw("body"), patterns)})`;
}

/**
 * Delete every working note in the org `namesPerson` matches, live or ended, each with a
 * `delete` change event, as a release has, so an agent told of the note hears it ended.
 *
 * Person erasure runs this inside its last transaction, over every note in the org rather
 * than those written since the request started: a renewal rewrites an older note's body,
 * so a note's creation time does not say when it last named anyone, and a note is a task
 * name and at most 280 characters, so the whole scan is short. Re-applying erasures after a
 * restore (services/memory/erasure-reapply.ts) passes the notes it judged restored copies, as
 * they read then, so a note renewed since with other text is not one of them.
 *
 * A renewal reads its agent's note and then updates it by id under the agent's note lock,
 * so a note is deleted only while its agent's lock is held here: otherwise the delete could
 * land between the read and the update and fail the renewal. The org's note-deletion lock
 * comes first, so no other deletion in the org holds agent locks meanwhile and the rounds
 * cannot deadlock with one; a note from an agent first seen after a round's delete is caught
 * by the next round.
 * The change events come after every round, because a renewal takes the org's change-feed
 * lock while holding its agent's lock, and a round may still wait on that agent.
 */
export async function deleteWorkingNotes(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  namesPerson: Prisma.Sql,
): Promise<number> {
  const removed = await inNoteAgentRounds(
    tx,
    ctx,
    namesPerson,
    (locked) =>
      tx.$queryRaw<{ id: string; scopePath: string }[]>`
      DELETE FROM working_notes
      WHERE "orgId" = ${ctx.orgId} AND ${namesPerson} AND "agentId" = ANY (${locked}::text[])
      RETURNING id, "scopePath"
    `,
  );
  for (const note of removed) {
    await recordChangeEvent(tx, {
      orgId: ctx.orgId,
      scopePath: note.scopePath,
      recordType: WORKING_NOTE_RECORD_TYPE,
      recordId: note.id,
      op: "delete",
      actorId: ctx.actor.id,
      actorType: ctx.actor.type,
      origin: ctx.origin,
      title: "",
    });
  }
  return removed.length;
}

/**
 * Empty the touches of every claim in the org `namesPerson` matches, keeping the claim. A
 * touch is a file path, and a path can name a person (`customers/Dana Whitfield/renewal.md`);
 * the claim's task and body are judged by deleteWorkingNotes. Clearing touches costs only an
 * overlap notice until the hook sends the list again, so a match that is not really the person
 * loses nothing that matters: the safe direction to err in. No change event: touches are
 * never shown in one. Returns how many claims it cleared.
 */
export async function clearWorkingNoteTouches(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  namesPerson: Prisma.Sql,
): Promise<number> {
  const cleared = await inNoteAgentRounds(
    tx,
    ctx,
    namesPerson,
    (locked) =>
      tx.$queryRaw<{ id: string }[]>`
      UPDATE working_notes SET touches = ARRAY[]::text[]
      WHERE "orgId" = ${ctx.orgId} AND ${namesPerson} AND "agentId" = ANY (${locked}::text[])
      RETURNING id
    `,
  );
  return cleared.length;
}

/**
 * Run `act` over the notes `matching` selects, holding the note lock of every agent whose
 * notes it touches, in rounds until no matching note is left from an agent not yet locked (see
 * deleteWorkingNotes for why the locks are taken this way). `act` must leave its rows no
 * longer matching, as a delete or a clear does, or the rounds would not end.
 */
async function inNoteAgentRounds<T>(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  matching: Prisma.Sql,
  act: (lockedAgents: string[]) => Promise<T[]>,
): Promise<T[]> {
  await lockNoteDeletions(tx, ctx.orgId);
  const locked: string[] = [];
  const done: T[] = [];
  for (;;) {
    const unlocked = await tx.$queryRaw<{ agentId: string }[]>`
      SELECT DISTINCT "agentId" FROM working_notes
      WHERE "orgId" = ${ctx.orgId} AND ${matching} AND NOT ("agentId" = ANY (${locked}::text[]))
      ORDER BY "agentId"
    `;
    if (unlocked.length === 0) return done;
    for (const { agentId } of unlocked) {
      await lockAgentNotes(tx, ctx.orgId, agentId);
      locked.push(agentId);
    }
    done.push(...(await act(locked)));
  }
}

/** Separators a file path writes a name across (`dana-whitfield`, `Dana_Whitfield`, `dana.whitfield`, `dana/whitfield`). */
const PATH_SEPARATORS = "[-_./]+";

/**
 * File paths as erasure reads them for a name: as written, then again with their separators as
 * spaces. The one reading both erasure (in SQL, {@link pathsAsTextSql}) and its re-application
 * after a restore (erasure-reapply.ts, in code) judge a claim's touches and an overlap's
 * summary by, so the two cannot find different paths. The second reading also matches a longer
 * name that starts with the person's (`Dana Whitfield-Barnes`); clearing touches is the side to err on.
 */
export function pathsAsText(paths: string): string {
  return `${paths}\n${paths.replace(new RegExp(PATH_SEPARATORS, "g"), " ")}`;
}

/** {@link pathsAsText} in SQL, over the text `paths` evaluates to. */
function pathsAsTextSql(paths: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${paths} || E'\\n' || regexp_replace(${paths}, ${PATH_SEPARATORS}, ' ', 'g'))`;
}

/** Whether paths, read by {@link pathsAsText}, name the person: as text, and as record names, as an upload's filename is. */
function pathsNamePerson(paths: Prisma.Sql, targets: ErasureTargets, patterns: TextPatterns): Prisma.Sql {
  const text = pathsAsTextSql(paths);
  return Prisma.sql`(${matchesText(text, patterns)} OR ${matchesText(text, recordNamePatterns(targets))})`;
}

/** Whether an overlap's summary, which lists file paths, names the person as a path writes a name ({@link pathsNamePerson}). */
function overlapSummaryNamesPerson(targets: ErasureTargets, patterns: TextPatterns): Prisma.Sql {
  return Prisma.sql`("recordType" = ${CLAIM_OVERLAP_RECORD_TYPE} AND ${pathsNamePerson(Prisma.raw("summary"), targets, patterns)})`;
}

/** Whether a claim's touches name the person ({@link pathsNamePerson}). */
function touchesNamePerson(targets: ErasureTargets, patterns: TextPatterns): Prisma.Sql {
  return Prisma.sql`(cardinality(touches) > 0 AND ${pathsNamePerson(Prisma.raw(`array_to_string(touches, E'\\n')`), targets, patterns)})`;
}

/**
 * Replace the frozen contact in every ledger row that holds the person with a
 * copy carrying only non-personal fields. The row itself stays: a replay of the
 * original create must still find its key, or it would recreate the person.
 * `erased: true` both tells a replaying caller what happened and keeps a second
 * erasure from counting the row again.
 */
function scrubLedgerSnapshots(tx: Prisma.TransactionClient, orgId: string, targets: ErasureTargets): Promise<number> {
  return tx.$executeRaw`
    UPDATE contact_idempotency_keys
    SET "resultSnapshot" = jsonb_build_object(
      'id', "resultSnapshot"->'id',
      'name', '',
      'email', NULL,
      'title', NULL,
      'description', NULL,
      'type', "resultSnapshot"->'type',
      'status', "resultSnapshot"->'status',
      'suppressed', "resultSnapshot"->'suppressed',
      'revision', "resultSnapshot"->'revision',
      'erased', true
    )
    WHERE "orgId" = ${orgId}
      AND NOT coalesce(("resultSnapshot"->>'erased')::boolean, false)
      AND (
        "contactId" = ANY (${targets.contactIds}::text[])
        OR "resultSnapshot"->>'id' = ANY (${targets.contactIds}::text[])
        OR ${foldedText(Prisma.raw(`"resultSnapshot"->>'email'`))} = ANY (${targets.emails}::text[])
        OR ${foldedText(Prisma.raw(`"resultSnapshot"->>'name'`))} = ANY (${targets.names}::text[])
      )
  `;
}
