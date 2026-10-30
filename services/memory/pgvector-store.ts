// PgvectorMemoryStore — lightweight semantic chunk store backed by Neon pgvector.
// Stores raw content + BGE-384 embeddings obtained from the memory-service /embed
// endpoint (same model as Graphiti, so both stores share one embedding space).
//
// Retrieval: cosine nearest-neighbour search (`<=>` operator) filtered by orgId and
// optionally scopePath prefix, so scope-based access control is enforced even at the DB
// layer, and to current versions only: a version that lost a write race is left out, or,
// for the guarded read that hands its place to its successor, marked `retired`.
// A row longer than one passage is also stored as overlapping passage embeddings
// (services/memory/passages.ts), because the embedding model reads only a text's first
// 512 tokens. A search ranks rows both by their own embedding and by their best passage
// and alternates the two orders (services/memory/passage-ranking.ts); the row is what it
// returns. Rows are searched exactly; passages through an HNSW index (see retrieve()).
// A query that quotes stored text also finds the rows holding its words, through a trigram
// index, and that ranking is fused into the order (services/memory/text-match-fusion.ts).
// With RETRIEVAL_TEXT_SPANS on, so do the literal spans a query holds: quoted text,
// identifiers, paths, error codes, numbers (services/memory/text-spans.ts).
//
// This store is NOT the access gate — that is GuardedMemoryStore / check(). This
// is the storage backend; the guard wraps it upstream.

import { createId } from "@paralleldrive/cuid2";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { Prisma } from "@/lib/generated/prisma/client";
import { flattenSql, orgRootPath, scopeContainsSql } from "@/services/access";
import { ingestContentKey } from "./ingest-content-key";
import { StoreRefusedError, type MemoryStore } from "./memory-store";
import { DEFAULT_ACCOUNT_TIER, TIER_LIMITS } from "./account-tiers";
import { embedTexts, getEmbedding } from "./embedding-service";
import { interleaveRowAndPassageRanks } from "./passage-ranking";
import { fuseTextRanking, opensWithPattern, quotedTextPattern } from "./text-match-fusion";
import {
  compareSpanHits,
  extractLiteralSpans,
  literalSpanPattern,
  mostSelectiveFirst,
  probeBudgetMs,
  SPAN_RANKING_DEPTH,
  spanHits,
  spanSimilarityFloor,
  spanMatchCap,
  textSpansEnabled,
  type SpanHit,
} from "./text-spans";
import { splitPassages } from "./passages";
import type {
  IngestInput,
  IngestResult,
  SearchInput,
  StoreRead,
  SearchResult,
  EntityLookup,
  MemoryEntity,
  MemoryFact,
  GraphInput,
  MemoryGraph,
  RemoveEntityInput,
  RemoveFactInput,
  RemoveFactResult,
  TransferEntityInput,
  TransferEntityResult,
  FindFactByIdInput,
  FindFactByIdResult,
} from "@/types/memory";

/**
 * How long the text leg's query may run (services/memory/text-match-fusion.ts). A quote of
 * common words in an order no row holds makes the trigram index hand back most of the org
 * to recheck; past this the database stops the query and the read goes on without the leg.
 */
const TEXT_LEG_TIMEOUT_MS = 300;

/**
 * Errors after which a read goes on without its text leg: the leg ran past
 * TEXT_LEG_TIMEOUT_MS (57014), or Postgres would not build its expression (2201B).
 */
const TEXT_LEG_GIVES_UP = new Set(["57014", "2201B"]);

/** Postgres errors for a table, column, type or operator the search needs and the database lacks. */
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "42704", "42883"]);

/** The SQLSTATE Prisma's pg adapter reports for a failed raw query, if it carries one. */
export function sqlState(error: unknown): string | undefined {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }).meta;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}

/** A float array as a Postgres vector literal: '[0.1,0.2,...]'. */
export function pgVec(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** The columns every stored row fills, in the order {@link rowValues} lists them. */
const INSERT_COLUMNS = Prisma.sql`("id","orgId","content","source","actorType","actorId","actorName","entityName","scopePath","sourceId","uploadId","contentKey","factVersion","baseVersionId","role","embedding","occurredAt","receivedAt","createdAt")`;

/**
 * The columns a writer decides for its row rather than reading from the input: the
 * content key (`ingestOnce` only) and whether the row is a version of the fact its
 * name names (`factVersion`, true from `ingestOnce` only; services/memory/conflict.ts).
 * Only a version records the `baseVersion` it was written to replace.
 */
interface RowMarks {
  contentKey: string | null;
  factVersion: boolean;
}

/** The client a row is stored through: the shared one, or an open transaction. */
type SqlClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/** A row's content with every embedding it is stored with. */
interface EmbeddedContent {
  /** The content's own embedding, which reads only its first 512 tokens. */
  embedding: number[];
  /** One embedding per passage, in order; empty when the content fits in one passage. */
  passages: number[][];
}

/**
 * Embed `content` and each of its passages. Throws if any embedding fails, or once
 * `signal` aborts, so a row is never stored without the passages it should have.
 */
async function embedContent(content: string, signal?: AbortSignal): Promise<EmbeddedContent> {
  const [embedding, passages] = await Promise.all([getEmbedding(content, signal), embedPassages(content, signal)]);
  return { embedding, passages };
}

/**
 * Embed each passage of `content`, in bounded batches (embedding-service.ts). Empty when
 * it fits in one; throws if any embedding fails.
 */
export async function embedPassages(content: string, signal?: AbortSignal): Promise<number[][]> {
  return (await embedPassagesOf([content], signal))[0]!;
}

/**
 * Embed the passages of every content in one stream of batches, so many short lists of
 * passages share full batches. Returns one list per content, in order.
 */
async function embedPassagesOf(contents: string[], signal?: AbortSignal): Promise<number[][][]> {
  const passages = contents.map(splitPassages);
  const embeddings = await embedTexts(
    passages.flat().map((passage) => passage.text),
    signal,
  );
  let next = 0;
  return passages.map((ofContent) => ofContent.map(() => embeddings[next++]!));
}

/** Passages per INSERT when rows are given their passages after they are stored. */
const PASSAGES_PER_STATEMENT = 256;

/**
 * Store each row's passages after the rows themselves were committed. Rows are grouped
 * into statements of at most about PASSAGES_PER_STATEMENT passages, and a row's passages
 * never span two statements, so each row ends up with all of its passages or none. A
 * statement that fails is logged and skipped: its rows are already stored and searchable
 * by their own embedding, and scripts/backfill-passage-embeddings.ts gives a row with no
 * passages its passages. Returns how many rows got theirs.
 */
async function storePassagesAfterRows(rows: { id: string; passages: number[][] }[]): Promise<number> {
  const statements: { id: string; passages: number[][] }[][] = [];
  let current: { id: string; passages: number[][] }[] = [];
  let size = 0;
  for (const row of rows.filter((r) => r.passages.length > 0)) {
    if (current.length > 0 && size + row.passages.length > PASSAGES_PER_STATEMENT) {
      statements.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += row.passages.length;
  }
  if (current.length > 0) statements.push(current);

  let stored = 0;
  for (const group of statements) {
    const values = group.flatMap(({ id, passages }) =>
      passages.map((embedding, ordinal) => Prisma.sql`(${id}, ${ordinal}::int, ${pgVec(embedding)}::vector)`),
    );
    try {
      await db.$executeRaw(
        ...flattenSql(Prisma.sql`
          INSERT INTO memory_chunk_passages ${PASSAGE_COLUMNS} VALUES ${Prisma.join(values)}
          ON CONFLICT ("chunkId","ordinal") DO NOTHING
        `),
      );
      stored += group.length;
    } catch (error) {
      console.warn(
        `[pgvector] passages for ${group.length} stored rows were not written; the backfill will add them:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return stored;
}

const PASSAGE_COLUMNS = Prisma.sql`("chunkId","ordinal","embedding")`;

/** A row's passages as a VALUES list of (ordinal, embedding), in order. */
function passageValues(passages: number[][]): Prisma.Sql {
  return Prisma.sql`(VALUES ${Prisma.join(
    passages.map((embedding, ordinal) => Prisma.sql`(${ordinal}::int, ${pgVec(embedding)}::vector)`),
  )})`;
}

/**
 * The INSERT for row `chunkId`'s passages, or null when it has none. A passage already
 * stored is left as it is, so writing a row's passages again changes nothing.
 */
export function insertPassagesSql(chunkId: string, passages: number[][]): Prisma.Sql | null {
  if (passages.length === 0) return null;
  return Prisma.sql`
    INSERT INTO memory_chunk_passages ${PASSAGE_COLUMNS}
    SELECT ${chunkId}::text, passage.* FROM ${passageValues(passages)} AS passage
    ON CONFLICT ("chunkId","ordinal") DO NOTHING
  `;
}

/** One row's VALUES tuple for {@link INSERT_COLUMNS}. */
function rowValues(id: string, input: IngestInput, marks: RowMarks, embedding: number[]): Prisma.Sql {
  return Prisma.sql`(
    ${id}, ${input.groupId}, ${input.content}, ${input.source ?? "text"},
    ${input.actorType}, ${input.actorId}, ${input.actorName ?? null}, ${input.name ?? null},
    ${input.scopePath ?? null}, ${input.sourceId ?? null}, ${input.uploadId ?? null},
    ${marks.contentKey}, ${marks.factVersion}, ${marks.factVersion ? (input.baseVersion ?? null) : null}, ${input.role ?? null}::"FactRole", ${pgVec(embedding)}::vector,
    ${occurredAtValue(input.occurredAt)}, ${marks.factVersion ? receivedAtValue(input.receivedAt) : Prisma.sql`NULL`}, ${sqlUtcNow}
  )`;
}

/**
 * The `receivedAt` value for a fact version: when the server received the write
 * (services/memory/received-at.ts), as UTC wall-clock time like `createdAt`, or NULL when
 * the write carries none, so the version is judged by its `createdAt`
 * (services/memory/conflict.ts). Never later than the row's `createdAt`: a write is
 * received before it is stored, and the clamp keeps that true whatever the value says.
 */
function receivedAtValue(receivedAt: string | undefined): Prisma.Sql {
  // Passed to SQL as given, not through a Date, which would drop its microseconds; the
  // column's cast rounds them as it rounds every other timestamp (received-at.ts).
  if (receivedAt === undefined || Number.isNaN(Date.parse(receivedAt))) return Prisma.sql`NULL`;
  return Prisma.sql`LEAST((${receivedAt}::timestamptz AT TIME ZONE 'UTC')::timestamp(3), ${sqlUtcNow})`;
}

/**
 * The `occurredAt` value for a write's stated event time: the instant as UTC wall-clock
 * time, the form `createdAt` holds (lib/sql-utc-now.ts), or NULL when the write states
 * none or states something that is not a date, so the row is dated by when it was stored.
 *
 * Never later than the moment the row is written. Reads serve the newest version of a fact
 * first, so a stated time ahead of the server clock (memory_ingest allows a few minutes of
 * clock skew) would let a note be read as newer than writes that came after it. This is the one place
 * every vector row is written, so the clamp holds for every writer.
 */
function occurredAtValue(occurredAt: string | undefined): Prisma.Sql {
  const at = occurredAt === undefined ? Number.NaN : Date.parse(occurredAt);
  if (Number.isNaN(at)) return Prisma.sql`NULL`;
  return Prisma.sql`LEAST((${new Date(at).toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${sqlUtcNow})`;
}

/**
 * How many lists of the embedding index one search reads: all of them.
 * memory_chunks_embedding_idx is IVFFlat with lists = 100, so reading 100 makes
 * the search exact.
 *
 * The migrations create that index on an empty table, so its lists are seeded
 * from random vectors instead of learned from the data, and the list a chunk sits
 * in says little about which queries it is near. Measured on the workload in
 * pgvector-recall.realdb.test.ts (1,000 to 3,000 chunks per org): reading one list,
 * pgvector's default, found 14 to 34 percent of the nearest 40 chunks and sometimes
 * returned fewer than 40; reading 40 lists still missed some; only reading every
 * list found all of them on every index build. Fewer lists become safe only after
 * the index is rebuilt on real data.
 */
const EMBEDDING_INDEX_PROBES = 100;

/**
 * How many passages a search takes from the passage index per result it returns. A
 * row can have several passages near the query, so this is more than one per result:
 * the parents of these passages are the passage leg's candidates. Measured on a
 * 20,000-row org with 12 passages a row: 4 gave the same fixture recall as an exact
 * search and added 55 ms to the read's p95; 10 added 160 ms, for no recall gained.
 */
const PASSAGE_CANDIDATES_PER_RESULT = 4;

/**
 * Bounds on `hnsw.ef_search`, the passage index's search width. It is set to the
 * passage candidate count within these bounds: below the count the index could not
 * return that many passages, and pgvector refuses values above 1,000.
 */
const HNSW_EF_SEARCH_MIN = 100;
const HNSW_EF_SEARCH_MAX = 1_000;

/**
 * Turns on pgvector's iterative index scans for this transaction, when the database's
 * pgvector has them (0.8.0 and later; an earlier one refuses the setting, so the version
 * is checked in the same statement). With them, the passage index keeps reading past
 * `ef_search` while the read's filters reject what it found (another org's or scope's
 * passages), so the passage leg still brings its candidates in a table many orgs share.
 * Without them it brings fewer, and the row leg alone still fills the page.
 */
const ITERATIVE_SCAN_WHEN_AVAILABLE = `SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)
  FROM pg_extension WHERE extname = 'vector' AND extversion !~ '^0\\.[0-7](\\.|$)'`;

/**
 * How many times one read searches again after excluding rows an erasure suppresses (a
 * restored backup's copies; retrieve()). Each round costs one more query, and only a
 * read whose candidates include such a row pays it.
 */
const MAX_SUPPRESSION_ROUNDS = 3;

/**
 * Keeps a read to versions no other version supersedes: a version that lost a write
 * race (services/memory/conflict.ts) has an incoming `supersedes` edge from the winner,
 * so a reader asking the fact gets the winner alone. The losing row is not deleted; it
 * stays readable by id (services/memory/versions.ts). Filtered before the LIMIT, so a
 * hidden loser never costs the page a slot.
 */
export const CURRENT_VERSIONS_ONLY = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM fact_edges superseding
  WHERE superseding."orgId" = memory_chunks."orgId"
    AND superseding."toId" = memory_chunks."id"
    AND superseding."kind" = 'supersedes'
)`;

/** The columns of a `memory_chunks` row a read serves, under the names the read selects them as. */
export interface StoredChunkRow {
  id: string;
  content: string;
  created_at: Date | null;
  occurred_at: Date | null;
  actor_type: string;
  actor_name: string | null;
  source_id: string | null;
  entity_name: string | null;
  scope_path: string | null;
  fact_version: boolean | null;
}

/**
 * A stored row as a read serves it, before any score of the read's own is attached. The
 * vector search and the current-version lookup (services/memory/current-versions.ts) both
 * build their facts here, so a version reads the same however it reached the page.
 */
export function storedChunkFact(r: StoredChunkRow): MemoryFact {
  return {
    uuid: r.id,
    fact: r.content,
    // When the content happened: the event time its writer stated, else when it was stored.
    validAt: (r.occurred_at ?? r.created_at)?.toISOString() ?? null,
    validAtSource: r.occurred_at ? "occurred" : "stored",
    // The fact this row is a version of, when the fact path stored it as one: a read
    // serves the newest version of a fact first (guarded-store.ts, breakTiesByRecency).
    ...(r.fact_version && r.entity_name ? { subject: JSON.stringify([r.scope_path, r.entity_name]) } : {}),
    ...(r.scope_path ? { scopePath: r.scope_path } : {}),
    // "human" | "agent" | "extraction" — column default is "extraction", never null,
    // so this always carries a real tier for GuardedMemoryStore's provenance ranking.
    actorType: r.actor_type as MemoryFact["actorType"],
    actorName: r.actor_name ?? undefined,
    sourceId: r.source_id ?? undefined,
    store: "semantic",
  };
}

/**
 * The ranked rows up to and including the `limit`-th current one: a page of `limit` current
 * rows, with every retired row that ranks among them, marked, in its place. Without retired
 * rows this is the first `limit`.
 */
function upToCurrentRows<T extends { retired: boolean }>(ranked: readonly T[], limit: number): T[] {
  const page: T[] = [];
  let current = 0;
  for (const row of ranked) {
    if (current === limit) break;
    page.push(row);
    if (!row.retired) current++;
  }
  return page;
}

/**
 * The rows a read may see, as SQL over `memory_chunks`: the reader's tenant, rows with an
 * embedding, current versions only, and the reader's scope. Every leg of a read applies it.
 *
 * Tenant isolation keys on the bare org id. `groupId` may be the scope-encoded path (Graphiti
 * needs that), so the explicit `tenantId` the guard passes is preferred.
 *
 * Scope filtering is exact match or prefix match (scope.xxx is a child scope), through the one
 * shared containment predicate (services/access/scope-containment.ts), not a hand-rolled
 * "= OR LIKE ... ESCAPE". Rows without a scopePath are the bare-org/untagged partition:
 * ordinary org content that happens to be untagged (several ingest paths write with no scope
 * at all), not a deliberately public bucket. They are included only when the caller's own
 * checked scope for this read covers org root (`includeUntagged`, set by GuardedMemoryStore
 * from pathCovers). A narrow-scoped caller gets ordinary containment only, never the untagged
 * rows. `scopePath` needs no table name: of the tables a leg joins, only memory_chunks has one.
 */
function readableRows(input: SearchInput): { scopeFilter: Prisma.Sql; readable: Prisma.Sql } {
  const tenantId = input.tenantId ?? input.groupId;
  const scope = input.scopePath;
  const scopeFilter = scope
    ? Prisma.sql`AND ${scopeContainsSql(Prisma.raw('"scopePath"'), scope, {
        relation: "within",
        mode: "text",
        includeUntagged: input.includeUntagged,
      })}`
    : Prisma.empty;
  const readable = Prisma.sql`memory_chunks."orgId" = ${tenantId}
        AND memory_chunks.embedding IS NOT NULL
        AND ${CURRENT_VERSIONS_ONLY}
        ${scopeFilter}`;
  return { scopeFilter, readable };
}

/**
 * The text leg: the `readable` rows that hold the quoted words in order (`quote`, from
 * quotedTextPattern, through the trigram index on content), each with whether it opens with
 * them. A quote more than `limit` rows hold names no one row, and the leg brings none; the
 * query stops at `limit` + 1 matches, so a common phrase costs a bounded scan. It runs under
 * a statement timeout in a transaction of its own, so the database itself stops a slow one,
 * and a leg that gives up (TEXT_LEG_GIVES_UP) finds nothing rather than failing the read.
 */
async function quotedRows(readable: Prisma.Sql, quote: string | null, limit: number): Promise<Map<string, boolean>> {
  if (quote === null) return new Map();
  try {
    const [, found] = await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${TEXT_LEG_TIMEOUT_MS}`),
      db.$queryRaw<QuoteRow[]>(...flattenSql(quoteSql(readable, quote, limit))),
    ]);
    return quoteHits(found, limit);
  } catch (e) {
    const code = sqlState(e);
    if (code !== undefined && TEXT_LEG_GIVES_UP.has(code)) return new Map();
    throw e;
  }
}

type QuoteRow = { id: string; opens_with_query: boolean };

/** The quote's query: the `readable` rows holding `quote`, at most `limit` + 1, each with whether it opens with it. */
function quoteSql(readable: Prisma.Sql, quote: string, limit: number): Prisma.Sql {
  return Prisma.sql`
                SELECT memory_chunks.id, memory_chunks.content ~* ${opensWithPattern(quote)} AS opens_with_query
                FROM memory_chunks
                WHERE ${readable} AND memory_chunks.content ~* ${quote}
                LIMIT ${limit + 1}`;
}

/** The quote's rows; none when more than `limit` rows hold it. */
function quoteHits(found: readonly QuoteRow[], limit: number): Map<string, boolean> {
  return found.length > limit ? new Map() : new Map(found.map((r) => [r.id, r.opens_with_query]));
}

/**
 * The text leg with literal spans (RETRIEVAL_TEXT_SPANS): the quote's rows as quotedRows
 * finds them, and for each span of the query (services/memory/text-spans.ts) the `readable`
 * rows that hold it, through the same trigram index, each probe stopping at `cap` + 1 rows.
 *
 * One transaction, so one pooled connection. TEXT_LEG_TIMEOUT_MS starts once the connection
 * is held (inside the callback), so a read that waited for the pool still gets its whole
 * budget. The statements run one after another: the quote first, then the spans, longest
 * first (mostSelectiveFirst). Each probe runs in a savepoint under its fair share of the
 * time left (probeBudgetMs), so a span with common trigrams and no match costs at most its
 * share and the probes after it still run. A probe that gives up (TEXT_LEG_GIVES_UP) is
 * rolled back to its savepoint and finds nothing. After each probe the timeout is lifted
 * again, so the savepoint commands and COMMIT never run under a probe's few milliseconds.
 * A transaction that still gives up or outlives its own timeout keeps what the probes found.
 * A span more than `cap` rows hold is ignored (spanHits).
 */
async function probedTextRows(
  readable: Prisma.Sql,
  quote: string | null,
  limit: number,
  spans: readonly string[],
  cap: number,
): Promise<{ quoted: Map<string, boolean>; spanned: Map<string, SpanHit> }> {
  let quoted = new Map<string, boolean>();
  const matches = spans.map(() => [] as string[]);
  const done = () => ({ quoted, spanned: spanHits(matches, cap) });
  try {
    await db.$transaction(
      async (tx) => {
        const deadline = Date.now() + TEXT_LEG_TIMEOUT_MS;
        let remaining = spans.length + (quote === null ? 0 : 1);
        const probe = async <T>(sql: Prisma.Sql): Promise<T[] | null> => {
          const budget = probeBudgetMs(deadline - Date.now(), remaining--);
          if (budget === null) return null;
          await tx.$executeRawUnsafe("SAVEPOINT text_leg_probe");
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${budget}`);
          let rows: T[] | null;
          try {
            rows = await tx.$queryRaw<T[]>(...flattenSql(sql));
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT text_leg_probe");
          } catch (e) {
            const code = sqlState(e);
            if (code === undefined || !TEXT_LEG_GIVES_UP.has(code)) throw e;
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT text_leg_probe");
            rows = null;
          }
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 0");
          return rows;
        };
        if (quote !== null) quoted = quoteHits((await probe<QuoteRow>(quoteSql(readable, quote, limit))) ?? [], limit);
        for (const i of mostSelectiveFirst(spans)) {
          const found = await probe<{ id: string }>(Prisma.sql`
            SELECT memory_chunks.id FROM memory_chunks
            WHERE ${readable} AND memory_chunks.content ~* ${literalSpanPattern(spans[i]!)}
            LIMIT ${cap + 1}`);
          matches[i] = found?.map((r) => r.id) ?? [];
        }
      },
      { timeout: TEXT_LEG_TIMEOUT_MS * 4 },
    );
  } catch (e) {
    const code = sqlState(e);
    const expired = e instanceof Prisma.PrismaClientKnownRequestError && e.code === TRANSACTION_EXPIRED;
    if (!expired && (code === undefined || !TEXT_LEG_GIVES_UP.has(code))) throw e;
  }
  return done();
}

/**
 * What the text leg found for one row: whether it holds the quote (`opens` set; true when it
 * opens with it), and the literal spans it holds.
 */
interface TextHit {
  opens?: boolean;
  span?: SpanHit;
}

/**
 * The text leg's rows: the quote's first, then the rows only spans found. With no spans
 * (RETRIEVAL_TEXT_SPANS off, or a query holding none) this is the quote's rows alone.
 */
async function textLegRows(readable: Prisma.Sql, query: string, limit: number): Promise<Map<string, TextHit>> {
  const spans = textSpansEnabled() ? extractLiteralSpans(query) : [];
  const { quoted, spanned } =
    spans.length === 0
      ? { quoted: await quotedRows(readable, quotedTextPattern(query), limit), spanned: new Map<string, SpanHit>() }
      : await probedTextRows(readable, quotedTextPattern(query), limit, spans, spanMatchCap(limit));
  const hits = new Map<string, TextHit>([...quoted].map(([id, opens]) => [id, { opens }]));
  for (const [id, span] of spanned) hits.set(id, { ...hits.get(id), span });
  return hits;
}

/**
 * A filter for a text ranking already in order: every row the quote found, and the first
 * SPAN_RANKING_DEPTH rows only spans found.
 */
function withinSpanDepth<T>(hitOf: (row: T) => TextHit): (row: T) => boolean {
  let spanOnly = 0;
  return (row) => hitOf(row).opens !== undefined || ++spanOnly <= SPAN_RANKING_DEPTH;
}

/** The text leg's own order between two rows it found: the quote's rows, opening ones first, then by spans held. */
function compareTextHits(a: TextHit | undefined, b: TextHit | undefined): number {
  const quoteRank = (h: TextHit | undefined) => (h?.opens === undefined ? 0 : h.opens ? 2 : 1);
  return quoteRank(b) - quoteRank(a) || compareSpanHits(a?.span, b?.span);
}

/** What `ingestOnce` found: the row that now holds the content, and whether this
 * call created it. */
export interface IngestOnceResult extends IngestResult {
  /** False when a row with the same content key already existed. */
  inserted: boolean;
  /**
   * When `inserted` is false: the existing row's dates. Nothing was written, so a stated
   * `occurredAt` that differs from the row's was not applied.
   */
  existingDates?: StoredDates;
}

/** What `ingestOnce` found when given a `sameTransaction`: on an insert, also what its `decide` returned. */
export type DecidedIngestOnceResult<Decided> =
  | (IngestOnceResult & { inserted: true; decided: Decided })
  | (IngestOnceResult & { inserted: false });

/**
 * Work that commits exactly when a stored version does: run in the transaction that inserts
 * it (`PgvectorMemoryStore.ingestOnce`), after the INSERT stored the row as `versionId`, and
 * not run when the content was already stored.
 */
export type VersionTransaction<Decided> = (tx: Prisma.TransactionClient, versionId: string) => Promise<Decided>;

/** Prisma's code for an interactive transaction that ran past its time limit. */
const TRANSACTION_EXPIRED = "P2028";
/** SQLSTATEs for a statement the database stopped waiting on: canceled (57014), lock not available (55P03). */
const GAVE_UP_WAITING = new Set(["57014", "55P03"]);

/**
 * Thrown by `ingestOnce` when the transaction that stores a version and decides its outcome
 * failed and the version is not stored: the transaction rolled back. The message names the
 * fact and says why in words; the database's own error, which can name tables and queries,
 * is `cause`.
 */
export class VersionNotStoredError extends Error {
  /** Why, in words: the database ran out of time (a lock wait or the transaction's limit), or failed. */
  readonly reason: string;

  constructor(input: Pick<IngestInput, "name" | "scopePath" | "groupId">, cause: unknown) {
    const timedOut =
      (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === TRANSACTION_EXPIRED) ||
      GAVE_UP_WAITING.has(sqlState(cause) ?? "");
    const reason = timedOut ? "the database did not finish storing it in time" : "the database failed while storing it";
    const fact = input.name?.trim() ? `"${input.name}"` : "the write";
    super(
      `${fact} in ${input.scopePath ?? orgRootPath(input.groupId)} was not stored: ${reason}. Nothing of it was kept.`,
      { cause },
    );
    this.name = "VersionNotStoredError";
    this.reason = reason;
  }
}

/** A stored row's stated event time (null when its writer stated none) and its write time. */
export interface StoredDates {
  occurredAt: Date | null;
  createdAt: Date;
}

/** The pgvector-backed MemoryStore; graph-only operations are no-ops here. */
export class PgvectorMemoryStore implements MemoryStore {
  /**
   * Store one row, embedding and all. Both a failed embedding and a failed
   * INSERT throw, so a caller that announces the row as readable
   * (`ingestMemory`'s write-through in lib/inngest/memory-ingest.ts,
   * `syncDriveFile`'s per-file outcome) never announces one that is not.
   *
   * This store writes no row without an embedding. `retrieve` is cosine ANN
   * search and filters on `embedding IS NOT NULL`, and nothing backfills the
   * column, so a row stored after a failed embedding would be unreadable here
   * forever while its ingest reported success. Failing is what lets the caller
   * retry; the hybrid store still tolerates the throw on its own, because the
   * graph leg is what it hands back.
   */
  /**
   * Store one row. `options.id` is the id to store it under, when the caller stamped it on
   * the content's graph episodes before this row was written (a Drive file's passages,
   * lib/inngest/connector-drive-files.ts); otherwise a new one.
   */
  async ingest(input: IngestInput, options: { id?: string } = {}): Promise<IngestResult> {
    const id = options.id ?? createId();
    await this.insertRow(db, id, input, { contentKey: null, factVersion: false }, await embedContent(input.content));
    return { episodeId: id };
  }

  /**
   * Store one row for each input, or none of them, so a caller that retries after a
   * failure never stores a row twice.
   *
   * Every embedding is fetched first: each input's own with its own outcome, and the
   * passages of every long input together, in bounded batches. If any input's embedding
   * fails, this throws an AggregateError holding each failed input's error, with the
   * failed positions in its message; if the passages' embedding fails, it throws that.
   * Either way nothing is written. The rows are then written by one INSERT inside one
   * transaction, with `sameTransaction` run after it: a write that must land exactly
   * when the rows do (a change-feed event announcing them) commits or rolls back with
   * them.
   *
   * The passages are written after that transaction commits, a few statements for the
   * whole call (storePassagesAfterRows). A long document's hundreds of passages would
   * otherwise hold the rows' transaction open past its timeout. A row whose passages
   * fail to write is still stored and searchable by its own embedding, and is not
   * retried here: the backfill gives it its passages.
   *
   * The rows are pieces of a document, never versions of a fact (`factVersion` false),
   * even when an input carries a name.
   *
   * @returns the stored rows' ids, in input order.
   */
  async ingestAll(
    inputs: IngestInput[],
    sameTransaction?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<string[]> {
    if (inputs.length === 0) return [];
    const passages = embedPassagesOf(inputs.map((input) => input.content));
    // Awaited below only when every row embedded; until then its failure is not unhandled.
    passages.catch(() => {});
    const outcomes = await Promise.allSettled(inputs.map((input) => getEmbedding(input.content)));
    const embeddings: number[][] = [];
    const failed: { i: number; reason: unknown }[] = [];
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") embeddings.push(outcome.value);
      else failed.push({ i, reason: outcome.reason });
    });
    if (failed.length > 0) {
      throw new AggregateError(
        failed.map(({ reason }) => reason),
        `${failed.length} of ${inputs.length} passages could not be embedded (positions ${failed.map(({ i }) => i + 1).join(", ")}); none were stored`,
      );
    }
    let embeddedPassages: number[][][];
    try {
      embeddedPassages = await passages;
    } catch (error) {
      throw new AggregateError(
        [error],
        `the passages of ${inputs.length} inputs could not be embedded; none were stored`,
      );
    }
    const ids = inputs.map(() => createId());
    const rows = inputs.map((input, i) =>
      rowValues(ids[i]!, input, { contentKey: null, factVersion: false }, embeddings[i]!),
    );
    await db.$transaction(async (tx) => {
      await tx.$executeRaw(
        ...flattenSql(Prisma.sql`INSERT INTO memory_chunks ${INSERT_COLUMNS} VALUES ${Prisma.join(rows)}`),
      );
      await sameTransaction?.(tx);
    });
    await storePassagesAfterRows(ids.map((id, i) => ({ id, passages: embeddedPassages[i]! })));
    return ids;
  }

  /**
   * Store one version of a fact unless a row with the same content key
   * (`ingestContentKey`: org, scope, name, normalized content) already exists in
   * the org, in which case return that row's id instead.
   *
   * This is the only write that marks its row a fact version (`factVersion`), and
   * it marks it in the INSERT itself: the winner rule and the stale-read checks
   * count the row from the moment it is stored. A row stored by `ingest` or
   * `ingestAll` carries the same columns but is never a version, even under a
   * fact's name.
   *
   * `options.sameTransaction` decides what the new version is, in the transaction that
   * stores it, right after the INSERT; the row commits with whatever it wrote, or not at
   * all. The write path passes the change feed's announcement there
   * (services/memory/fact-change-event.ts), so no reader is ever served a version whose
   * outcome is not yet recorded: a stale write-back is never current, not even while its
   * announcement waits for the org's lock.
   *
   * The row's `createdAt` is when its transaction began, before any wait on that lock, and
   * decides which of two versions was stored first. Its `receivedAt` is when the write was
   * received (`input.receivedAt`, services/memory/received-at.ts), before the embedding call
   * below: the stale-read and winner rules judge contention by it and compare it with when
   * the writer read other versions, so neither a slow embedding nor a read the writer makes
   * while its own write is in flight moves the write later than it was sent.
   *
   * The check is the unique index on `(orgId, contentKey)`, not a read before
   * the write: two identical ingests arriving at once both reach the INSERT, one
   * wins the index and the other sees the conflict, so they collapse to one row
   * without a lock of their own. The embeddings are computed before the INSERT,
   * outside any transaction, so a duplicate costs its embedding calls (one, plus one
   * per passage of a long row); the rows and passages it would have written, none.
   *
   * `options.signal` bounds those embedding calls: once it aborts, this throws its
   * reason and writes nothing. The request path passes one so a hung memory service
   * cannot hold a caller's reply (lib/inngest/memory-ingest.ts).
   *
   * @throws VersionNotStoredError when the transaction given a `sameTransaction` fails: it
   *   rolled back, so neither the row nor anything `sameTransaction` wrote was stored.
   */
  async ingestOnce(input: IngestInput, options?: { signal?: AbortSignal }): Promise<IngestOnceResult>;
  async ingestOnce<Decided>(
    input: IngestInput,
    options: { signal?: AbortSignal; sameTransaction: VersionTransaction<Decided> },
  ): Promise<DecidedIngestOnceResult<Decided>>;
  async ingestOnce<Decided>(
    input: IngestInput,
    options: { signal?: AbortSignal; sameTransaction?: VersionTransaction<Decided> } = {},
  ): Promise<IngestOnceResult | DecidedIngestOnceResult<Decided>> {
    const id = createId();
    const contentKey = ingestContentKey(input);
    const embedded = await embedContent(input.content, options.signal);
    const marks = { contentKey, factVersion: true };
    const settle = options.sameTransaction;
    if (!settle) return this.storeVersion(db, id, input, marks, embedded);
    try {
      return await db.$transaction(async (tx): Promise<DecidedIngestOnceResult<Decided>> => {
        const stored = await this.storeVersion(tx, id, input, marks, embedded);
        if (!stored.inserted) return { ...stored, inserted: false };
        return { ...stored, inserted: true, decided: await settle(tx, stored.episodeId) };
      });
    } catch (e) {
      // An error can arrive after the server committed (a connection dropped before the
      // acknowledgement). Then the version is stored with its outcome. When the database
      // cannot say which, neither can this: in both cases the caller's ordinary failure path
      // handles the write, and only a version known to be absent is reported as not stored.
      const stored = await this.storedVersionOf(input).then(
        (id) => id !== null,
        () => undefined,
      );
      if (stored !== false) throw e;
      throw new VersionNotStoredError(input, e);
    }
  }

  /** The INSERT of {@link ingestOnce}, through `client`, and the existing row when the content key was taken. */
  private async storeVersion(
    client: SqlClient,
    id: string,
    input: IngestInput,
    marks: RowMarks & { contentKey: string },
    embedded: EmbeddedContent,
  ): Promise<IngestOnceResult> {
    const insertedId = await this.insertRow(client, id, input, marks, embedded);
    if (insertedId !== null) return { episodeId: insertedId, inserted: true };

    // The conflicting row is committed by the time ON CONFLICT reports it,
    // so this read sees it.
    const contentKey = marks.contentKey;
    const rows = await client.$queryRaw<{ id: string; occurred_at: Date | null; created_at: Date }[]>`
      SELECT id, "occurredAt" as occurred_at, "createdAt" as created_at FROM memory_chunks WHERE "orgId" = ${input.groupId} AND "contentKey" = ${contentKey}
    `;
    const existing = rows[0];
    if (!existing)
      throw new Error(`memory_chunks: a row for content key ${contentKey} conflicted but could not be read back`);
    return {
      episodeId: existing.id,
      inserted: false,
      existingDates: { occurredAt: existing.occurred_at, createdAt: existing.created_at },
    };
  }

  /**
   * The id of the row an identical ingest (same content key) already stored in the
   * org, or null when there is none. Lets a caller answer a retry the way its first
   * attempt was answered before deciding anything about the write.
   */
  async storedVersionOf(input: IngestInput): Promise<string | null> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_chunks WHERE "orgId" = ${input.groupId} AND "contentKey" = ${ingestContentKey(input)}
    `;
    return rows[0]?.id ?? null;
  }

  /**
   * Whether row `chunkId` is still stored in the org and scope it was written to. Deleting
   * the fact removes it; a queued ingest job asks before and after its graph writes, so a
   * fact deleted while the job was pending is not left in the graph
   * (lib/inngest/memory-ingest.ts).
   */
  async isStored(input: { groupId: string; chunkId: string; scopePath: string | null }): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_chunks
      WHERE id = ${input.chunkId} AND "orgId" = ${input.groupId} AND "scopePath" IS NOT DISTINCT FROM ${input.scopePath}
    `;
    return rows.length > 0;
  }

  /**
   * INSERT the row with its embedding, and its passages with theirs, in one
   * statement through `client`, so both land or neither does. The caller embeds
   * first (`embedContent`), so a failed embedding throws before the INSERT: this
   * store has no way to read back a row without one, nor all of a long row without
   * its passages. With a content key, an existing row with that key in the org makes
   * the INSERT a no-op, and then no passages are written either. Returns the
   * inserted id, or null when the INSERT did nothing.
   *
   * `actorId` and `entityName` are stored so a version can be read back on its
   * own (services/memory/versions.ts), and `factVersion` so that only versions,
   * not every row under a fact's name, are recognized as writes to that fact
   * (services/memory/conflict.ts).
   */
  private async insertRow(
    client: SqlClient,
    id: string,
    input: IngestInput,
    marks: RowMarks,
    { embedding, passages }: EmbeddedContent,
  ): Promise<string | null> {
    const onConflict =
      marks.contentKey === null ? Prisma.empty : Prisma.sql`ON CONFLICT ("orgId", "contentKey") DO NOTHING`;
    const insertRow = Prisma.sql`
      INSERT INTO memory_chunks ${INSERT_COLUMNS}
      VALUES ${rowValues(id, input, marks, embedding)}
      ${onConflict}
      RETURNING id
    `;
    // Each companion write rides the INSERT as a CTE over `inserted`, so it lands exactly
    // when the row does: none of them when ON CONFLICT skips the row.
    const companions: Prisma.Sql[] = [];
    if (passages.length > 0) {
      companions.push(Prisma.sql`stored_passages AS (
        INSERT INTO memory_chunk_passages ${PASSAGE_COLUMNS}
        SELECT inserted.id, passage.* FROM inserted, ${passageValues(passages)} AS passage
      )`);
    }
    const derivedFrom = input.derivedFromTargets ?? [];
    if (derivedFrom.length > 0) {
      // A declared share (services/access/derived-writes.ts): the version is never stored
      // without the edges that mark where its content came from.
      const edges = derivedFrom.map((toId) => Prisma.sql`(${createId()}, ${toId})`);
      companions.push(Prisma.sql`derived_from AS (
        INSERT INTO fact_edges ("id","orgId","fromId","toId","kind","scopePath","actorType","actorId","createdAt")
        SELECT edge.id, ${input.groupId}, inserted.id, edge.to_id, 'derivedFrom'::"FactEdgeKind",
               ${input.scopePath ?? orgRootPath(input.groupId)}, ${input.actorType}::"ActorType", ${input.actorId}, ${sqlUtcNow}
        FROM inserted, (VALUES ${Prisma.join(edges)}) AS edge(id, to_id)
        ON CONFLICT ("orgId", "fromId", "toId", "kind") DO NOTHING
      )`);
    }
    const insert =
      companions.length === 0
        ? insertRow
        : Prisma.sql`
            WITH inserted AS (${insertRow}),
            ${Prisma.join(companions, ",\n")}
            SELECT id FROM inserted
          `;
    const rows = await client.$queryRaw<{ id: string }[]>(...flattenSql(insert));
    return rows[0]?.id ?? null;
  }

  async retrieve(input: SearchInput): Promise<SearchResult> {
    if (input.skipPgvector) return { facts: [], storesRead: [] };
    // Every early return below is a failed read, not an empty store: the
    // breakdown on the Ask page says so instead of showing zero hits. A failure
    // asking again cannot fix is thrown instead (StoreRefusedError), so the hybrid
    // store reports it without a retry and logs why.
    const failed: SearchResult = { facts: [], storesRead: [{ store: "semantic", failed: true }] };
    const { latencyCeilingMs } = TIER_LIMITS[input.accountTier ?? DEFAULT_ACCOUNT_TIER];
    let queryVec: number[];
    try {
      queryVec = await getEmbedding(input.query, AbortSignal.timeout(latencyCeilingMs));
    } catch (e) {
      if (e instanceof StoreRefusedError) throw e;
      return failed;
    }

    const limit = input.limit ?? 10;
    const tenantId = input.tenantId ?? input.groupId;
    type ChunkRow = StoredChunkRow & {
      retired: boolean;
      row_similarity: number;
      passage_similarity: number | null;
    };
    let rows: ChunkRow[];
    // The rows the text leg found in the last search round, each with what it matched.
    let quoted = new Map<string, TextHit>();

    try {
      // Which rows this read may see (`readableRows`). Every leg below applies all of it
      // (with any rows an erasure suppresses excluded too), and the final SELECT applies it
      // again, so a passage can change how a visible row ranks but never makes a hidden row visible.
      const { scopeFilter, readable } = readableRows(input);
      // A read that asks for retired rows (`withRetired`) also gets the nearest `limit` of
      // them, marked, from a leg of their own: the legs above stay exactly as they are, so
      // the current rows it returns are the ones a read without it returns.
      const retiredRows = Prisma.sql`memory_chunks."orgId" = ${tenantId}
        AND memory_chunks.embedding IS NOT NULL
        AND NOT ${CURRENT_VERSIONS_ONLY}
        ${scopeFilter}`;
      const queryVector = Prisma.sql`${pgVec(queryVec)}::vector`;
      const passageCandidates = limit * PASSAGE_CANDIDATES_PER_RESULT;
      // A row's similarity is the best of its own embedding's and its passages'.
      // Scoring every visible row's passages would be exact but grows with the
      // passage count, so the candidates come from two legs instead:
      //  - nearest_rows: the nearest visible rows by their own embedding, exact (the
      //    IVFFlat index reads every list, EMBEDDING_INDEX_PROBES). Being exact, it
      //    alone fills the page whenever the read can see `limit` rows, however the
      //    passage leg fares.
      //  - nearest_passages: the parents of the nearest passages whose parent is
      //    visible, through the HNSW index on memory_chunk_passages.
      // Each candidate is then scored exactly both ways (its own embedding, and its best
      // passage over all of them), and the page alternates between the two orders
      // (services/memory/passage-ranking.ts).
      //  - the text leg: when the query quotes stored text, the visible rows that hold its
      //    words in order (quotedTextPattern, through the trigram index on content), asked
      //    first in a query of their own, so a read whose quote no row holds runs exactly
      //    the search it ran before the leg existed. A quote more than `limit` visible rows
      //    hold names no one row, and the leg brings none; the query stops at `limit` + 1
      //    matches, so a common phrase costs a bounded scan. It runs once per read, under a
      //    statement timeout in a transaction of its own, so the database itself stops a slow
      //    one; a leg that times out leaves the read to the vector legs, never failing it.
      //    The rows it found join the candidates, and their ranking is fused into the order below.
      // `suppressed` names rows an erasure suppresses, found by an earlier round (below).
      //    With RETRIEVAL_TEXT_SPANS on, the leg also probes each literal span of the query
      //    (services/memory/text-spans.ts) the same way, beside the quote.
      const visibleSql = (suppressed: readonly string[]) =>
        suppressed.length === 0
          ? readable
          : Prisma.sql`${readable} AND memory_chunks.id <> ALL (${suppressed}::text[])`;
      const askTextLeg = () => textLegRows(readable, input.query, limit);
      // Asked once; a later round only drops the rows it has since found suppressed.
      let textLeg: Promise<Map<string, TextHit>> | null = null;
      const unsuppressedTextRows = async (suppressed: readonly string[]): Promise<Map<string, TextHit>> => {
        textLeg ??= askTextLeg();
        const excluded = new Set(suppressed);
        return new Map([...(await textLeg)].filter(([id]) => !excluded.has(id)));
      };
      const searchSql = (suppressed: readonly string[], textIds: readonly string[]) => {
        const visible = visibleSql(suppressed);
        const textCandidates =
          textIds.length === 0 ? Prisma.empty : Prisma.sql` UNION SELECT unnest(${textIds}::text[])`;
        const unsuppressed =
          suppressed.length === 0 ? Prisma.empty : Prisma.sql`AND memory_chunks.id <> ALL (${suppressed}::text[])`;
        const retiredLeg = input.withRetired
          ? Prisma.sql`nearest_retired AS (
            SELECT memory_chunks.id FROM memory_chunks
            WHERE ${retiredRows} ${unsuppressed}
            ORDER BY memory_chunks.embedding <=> ${queryVector}
            LIMIT ${limit}
          ),`
          : Prisma.empty;
        const retiredCandidates = input.withRetired ? Prisma.sql` UNION SELECT id FROM nearest_retired` : Prisma.empty;
        const retiredColumn = input.withRetired ? Prisma.sql`NOT ${CURRENT_VERSIONS_ONLY}` : Prisma.sql`false`;
        const servable = input.withRetired ? Prisma.sql`((${visible}) OR (${retiredRows} ${unsuppressed}))` : visible;
        return Prisma.sql`
          WITH ${retiredLeg} nearest_rows AS (
            SELECT memory_chunks.id FROM memory_chunks
            WHERE ${visible}
            ORDER BY memory_chunks.embedding <=> ${queryVector}
            LIMIT ${limit}
          ),
          nearest_passages AS (
            SELECT passage."chunkId" AS id
            FROM memory_chunk_passages passage
            JOIN memory_chunks ON memory_chunks.id = passage."chunkId"
            WHERE ${visible}
            ORDER BY passage.embedding <=> ${queryVector}
            LIMIT ${passageCandidates}
          )
          SELECT id, content, "createdAt" as created_at, "occurredAt" as occurred_at, "actorType" as actor_type,
                 "actorName" as actor_name, "sourceId" as source_id, "entityName" as entity_name,
                 "scopePath" as scope_path, "factVersion" as fact_version,
                 ${retiredColumn} as retired,
                 1 - (embedding <=> ${queryVector}) as row_similarity,
                 1 - (SELECT MIN(passage.embedding <=> ${queryVector})
                      FROM memory_chunk_passages passage
                      WHERE passage."chunkId" = memory_chunks.id) as passage_similarity
          FROM memory_chunks
          WHERE id IN (SELECT id FROM nearest_rows UNION SELECT id FROM nearest_passages${textCandidates}${retiredCandidates})
            AND ${servable}
          ORDER BY row_similarity DESC, id
        `;
      };
      // SET LOCAL ends with this transaction, so these settings never reach another
      // query on the pooled connection. SET takes no bind parameters; every value is
      // a constant or an integer computed here.
      const settings = [
        `SET LOCAL ivfflat.probes = ${EMBEDDING_INDEX_PROBES}`,
        `SET LOCAL hnsw.ef_search = ${Math.min(HNSW_EF_SEARCH_MAX, Math.max(HNSW_EF_SEARCH_MIN, passageCandidates))}`,
        ITERATIVE_SCAN_WHEN_AVAILABLE,
      ];
      const search = async (suppressed: readonly string[]) => {
        quoted = await unsuppressedTextRows(suppressed);
        return (
          await db.$transaction([
            ...settings.map((statement) => db.$executeRawUnsafe(statement)),
            db.$queryRaw<ChunkRow[]>(...flattenSql(searchSql(suppressed, [...quoted.keys()]))),
          ])
        ).at(-1) as ChunkRow[];
      };
      // A chunk an erasure should have removed and a restored backup put back is never
      // served (services/memory/erasure-suppression.ts). The suppression list is matched
      // here, not in SQL, so a suppressed row is excluded by id and the search run again:
      // it then holds no place in either leg's LIMIT, and the page is the one the read gets
      // with the row absent. Each round excludes at least one more row; past
      // MAX_SUPPRESSION_ROUNDS, rows still suppressed are only filtered out.
      const suppressed: string[] = [];
      let erased: ErasedContentFilter | null = null;
      rows = await search(suppressed);
      for (let round = 1; rows.length > 0; round++) {
        erased ??= await loadErasedContentFilter(tenantId);
        const isErased = erased;
        const hidden = rows.filter((r) => isErased(r.content, r.created_at, r.entity_name, r.id));
        if (hidden.length === 0) break;
        if (round > MAX_SUPPRESSION_ROUNDS) {
          rows = rows.filter((r) => !hidden.includes(r));
          break;
        }
        suppressed.push(...hidden.map((r) => r.id));
        rows = await search(suppressed);
      }
    } catch (e) {
      const code = sqlState(e);
      if (code !== undefined && MISSING_SCHEMA_CODES.has(code)) {
        throw new StoreRefusedError(
          `memory_chunks is missing what the vector search needs (Postgres ${code}). Run the pending migrations (npx prisma migrate deploy).`,
        );
      }
      return failed;
    }

    // Every candidate in the vector order, then the text leg's ranking fused in, then the
    // page cut: a row only the text leg found has a place in the vector order too (its own
    // similarity), so the cut can never drop it before the fusion has ranked it.
    const ranked = rows.map((r) => ({
      ...r,
      rowSimilarity: r.row_similarity,
      passageSimilarity: r.passage_similarity,
    }));
    // The text leg's own order: rows that open with the quote, then rows that hold it, then
    // rows by the literal spans they hold (compareTextHits), each by their own embedding's
    // similarity, then id; of the rows only spans found, those that clear the similarity
    // floor of a query mostly in prose (spanSimilarityFloor), then the first SPAN_RANKING_DEPTH.
    const bestSimilarity = (r: (typeof ranked)[number]) =>
      Math.max(r.rowSimilarity, r.passageSimilarity ?? r.rowSimilarity);
    const clearsProseFloor = spanSimilarityFloor(input.query, Math.max(...ranked.map(bestSimilarity)));
    const textRanking = ranked
      .filter((r) => quoted.has(r.id))
      .sort(
        (a, b) =>
          compareTextHits(quoted.get(a.id), quoted.get(b.id)) ||
          b.rowSimilarity - a.rowSimilarity ||
          (a.id < b.id ? -1 : 1),
      )
      .filter((r) => quoted.get(r.id)!.opens !== undefined || clearsProseFloor(bestSimilarity(r)))
      .filter(withinSpanDepth((r) => quoted.get(r.id)!));
    const textMatchRank = new Map(textRanking.map((r, i) => [r, i + 1]));
    return {
      facts: upToCurrentRows(
        fuseTextRanking(interleaveRowAndPassageRanks(ranked, ranked.length), textRanking),
        limit,
      ).map((r) => ({
        ...storedChunkFact(r),
        ...(r.retired ? { retired: true } : {}),
        // Cosine similarity of the row's best embedding, its own or a passage's: `<=>` is
        // cosine distance, so 1 minus it is 1 for an identical direction.
        similarity: Math.max(r.rowSimilarity, r.passageSimilarity ?? r.rowSimilarity),
        ...(textMatchRank.has(r) ? { textMatchRank: textMatchRank.get(r) } : {}),
      })),
      storesRead: [{ store: "semantic" }],
    };
  }

  /**
   * The text leg alone (services/memory/routing-policy.ts, `readLegs`): the rows this read
   * may see that hold the text its query quotes, rows opening with it first, then (with
   * RETRIEVAL_TEXT_SPANS on) at most SPAN_RANKING_DEPTH rows by the literal spans they hold,
   * each group newest first, at most `limit` in all. No embedding is asked: the text leg's
   * indexed queries (one transaction), then one fetch of the rows it found. A query that
   * quotes nothing and holds no span reads nothing. Rows an erasure suppresses are never
   * served; retired versions are left out.
   */
  async retrieveText(input: SearchInput): Promise<SearchResult> {
    if (input.skipPgvector) return { facts: [], storesRead: [] };
    const read: StoreRead = { store: "semantic", leg: "text" };
    const limit = input.limit ?? 10;
    const tenantId = input.tenantId ?? input.groupId;
    try {
      const { readable } = readableRows(input);
      const quoted = await textLegRows(readable, input.query, limit);
      if (quoted.size === 0) return { facts: [], storesRead: [read] };
      const rows = await db.$queryRaw<StoredChunkRow[]>(
        ...flattenSql(Prisma.sql`
          SELECT id, content, "createdAt" as created_at, "occurredAt" as occurred_at, "actorType" as actor_type,
                 "actorName" as actor_name, "sourceId" as source_id, "entityName" as entity_name,
                 "scopePath" as scope_path, "factVersion" as fact_version
          FROM memory_chunks
          WHERE id = ANY (${[...quoted.keys()]}::text[]) AND ${readable}`),
      );
      const isErased = await loadErasedContentFilter(tenantId);
      const ranked = rows
        .filter((r) => !isErased(r.content, r.created_at, r.entity_name, r.id))
        .sort(
          (a, b) =>
            compareTextHits(quoted.get(a.id), quoted.get(b.id)) ||
            (b.created_at?.getTime() ?? 0) - (a.created_at?.getTime() ?? 0) ||
            (a.id < b.id ? -1 : 1),
        )
        .filter(withinSpanDepth((r) => quoted.get(r.id)!))
        .slice(0, limit);
      return { facts: ranked.map((r, i) => ({ ...storedChunkFact(r), textMatchRank: i + 1 })), storesRead: [read] };
    } catch (e) {
      const code = sqlState(e);
      if (code !== undefined && MISSING_SCHEMA_CODES.has(code)) {
        throw new StoreRefusedError(
          `memory_chunks is missing what the text search needs (Postgres ${code}). Run the pending migrations (npx prisma migrate deploy).`,
        );
      }
      return { facts: [], storesRead: [{ ...read, failed: true }] };
    }
  }

  /**
   * How many rows this read may see still owe the graph their extraction: a row in
   * graph_extraction_retries stays until an attempt succeeds or the version is gone
   * (services/memory/graph-extraction-retry.ts). Rows a queued ingest job has not reached
   * yet are not recorded anywhere, so this is a lower bound.
   */
  async pendingAbsorption(input: SearchInput): Promise<number> {
    const { readable } = readableRows(input);
    const [row] = await db.$queryRaw<{ pending: number }[]>(
      ...flattenSql(Prisma.sql`
        SELECT COUNT(*)::int AS pending
        FROM graph_extraction_retries owed
        JOIN memory_chunks ON memory_chunks.id = owed."chunkId"
        WHERE ${readable}`),
    );
    return row?.pending ?? 0;
  }

  // Entities and the node graph are Graphiti-only concepts; pgvector exposes
  // them as no-ops so the MemoryStore interface is satisfied. removeFact and
  // findFactById below are real: a chunk is a fact this store can resolve.
  async entity(_input: EntityLookup): Promise<MemoryEntity | null> {
    return null;
  }

  async graph(_input: GraphInput): Promise<MemoryGraph> {
    return { nodes: [], edges: [] };
  }

  async removeFact(input: RemoveFactInput): Promise<RemoveFactResult> {
    // Tenant isolation keys on the bare org id, same split as retrieve() above.
    // `groupId` may be the scope-encoded path (Graphiti's removeFact wants that),
    // so prefer the explicit `tenantId` the guard passes; filtering on
    // `input.groupId` directly matches zero rows for a scoped delete (org id !=
    // scope path) while the hybrid store still reports removed:true.
    const tenantId = input.tenantId ?? input.groupId;
    // `input.groupId` is the exact scope check() authorized `memory.delete` on
    // (guarded-store.ts's removeFact), and the DELETE must compare it against
    // the row's own `scopePath`, not only the bare org id. Otherwise a caller
    // holding a delete grant on one narrow scope (e.g. `org_x.dealA`) can pass
    // any fact id in the same org (e.g. one under sibling `org_x.dealB`) and
    // delete it: a same-tenant cross-scope destroy. Same "within" containment
    // predicate retrieve() applies to reads, enforced on the one write path that
    // removes a row outright. `includeUntagged` mirrors retrieve()'s
    // hasOrgRootGrant gate: an untagged (`scopePath IS NULL`) row is deletable
    // only when the authorized scope IS org root, never from a narrower grant.
    const scope = input.groupId;
    const containment = scopeContainsSql(Prisma.raw('"scopePath"'), scope, {
      relation: "within",
      mode: "text",
      includeUntagged: scope === orgRootPath(tenantId),
    });
    const query = Prisma.sql`
      DELETE FROM memory_chunks
      WHERE id = ${input.factId} AND "orgId" = ${tenantId} AND ${containment}
      RETURNING "scopePath", "entityName"
    `;
    // At most one row: `id` is the primary key. Its scope says where the fact was stored,
    // which can be below the scope the delete was authorized at.
    const [deleted] = await db.$queryRaw<{ scopePath: string | null; entityName: string | null }[]>(
      ...flattenSql(query),
    );
    return deleted
      ? { removed: true, storedScopePath: deleted.scopePath, storedEntityName: deleted.entityName }
      : { removed: false };
  }

  async removeEntity(_input: RemoveEntityInput): Promise<RemoveFactResult> {
    return { removed: false }; // pgvector has no entity graph
  }

  async transferEntity(_input: TransferEntityInput): Promise<TransferEntityResult> {
    return { transferred: 0 }; // pgvector has no entity graph to transfer
  }

  async findFactById(input: FindFactByIdInput): Promise<FindFactByIdResult | null> {
    // Same three-part predicate removeFact() above uses for the one
    // other uuid-keyed operation here: the row's id, the bare tenant, and the
    // row's own scopePath contained within the authorized scope. A chunk in a
    // sibling scope matches zero rows and reads as "no such fact", identical
    // to a chunk id that exists nowhere.
    const tenantId = input.tenantId ?? input.groupId;
    const scope = input.groupId;
    const containment = scopeContainsSql(Prisma.raw('"scopePath"'), scope, {
      relation: "within",
      mode: "text",
      includeUntagged: scope === orgRootPath(tenantId),
    });
    const query = Prisma.sql`
      SELECT id, content, "scopePath"
      FROM memory_chunks
      WHERE id = ${input.factId} AND "orgId" = ${tenantId} AND ${containment}
      LIMIT 1
    `;
    const rows = await db.$queryRaw<{ id: string; content: string; scopePath: string | null }[]>(...flattenSql(query));
    const row = rows[0];
    // A chunk is never invalidated in place; a replacement is recorded as a
    // `supersedes` edge instead (services/memory/versions.ts).
    return row ? { uuid: row.id, fact: row.content, invalidAt: null, scopePath: row.scopePath } : null;
  }
}

/** Singleton pgvector store. */
export const pgvectorStore = new PgvectorMemoryStore();
