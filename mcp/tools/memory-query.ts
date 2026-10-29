// memory_query: ask business memory a question and get cited facts back.
// The one rule: the search is always scoped, defaulting to the token's own
// scope, so a read can never return more than the capability already covers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveCallerScopePath } from "@/services/access";
import { guardedMemory } from "@/services/memory";
import { provenanceRank } from "@/services/memory/guarded-store";
import { rankingLeadsApart, settledRuleCopiesFirst } from "@/services/memory/rule-copies";
import { neverClaimConflicts } from "@/services/memory/never-claims";
import { serveLaterUpdatesFirst } from "@/services/memory/update-links";
import { answerShapeOfQuery, preferenceBlock, preferenceQuery } from "@/services/memory/query-shapes";
import { aggregateDigestOfQuery, digestDays, digestText } from "@/services/memory/aggregate-digest";
import { formatCitedFactLines, storedVersionsBehind } from "../fact-citation";
import { checkedScopeNoteFor } from "../checked-scope";
import { derivedMarkersFor } from "../derived-write";
import {
  NO_READABLE_MATCH_NOTE,
  READ_GRANT_NOTE,
  neverClaimNote,
  UNHELD_VALUES_META_KEY,
  incompleteReadNotes,
} from "../read-notes";
import { IF_REVISION_DESCRIPTION, IF_REVISION_MAX_LENGTH, withRevisionReceipt } from "../revision-receipt";
import { recordServedFacts, toolError, type ToolContext } from "./tool-context";

/** memory_query's arguments; their descriptions are the tool's documentation, as clients list it. */
const memoryQueryInput = {
  query: z.string().describe("Natural-language question, e.g. 'what do we know about Acme?'"),
  limit: z.number().int().positive().max(50).optional().describe("Max facts to return (default 10)"),
  scopePath: z.string().optional().describe("ltree scope to search within. Defaults to your token's scope."),
  ifRevision: z.string().max(IF_REVISION_MAX_LENGTH).optional().describe(IF_REVISION_DESCRIPTION),
};

type MemoryQueryArgs = z.infer<z.ZodObject<typeof memoryQueryInput>>;

export function registerMemoryQuery(server: McpServer, toolContext: ToolContext): void {
  server.registerTool(
    "memory_query",
    {
      title: "Query business memory",
      description:
        "Ask Willder's business memory a question and get back known facts (people, companies, deals, history), each cited with the connected source or actor it came from. When the question names a specific value (a number, quoted text or a name) that no memory you can read holds, a fixed note says so. Ends with a revision; send it back as ifRevision to skip an answer you already hold. Access-scoped to your capability and audited.",
      inputSchema: memoryQueryInput,
    },
    toolContext.notifyingRead((args: MemoryQueryArgs) => handleMemoryQuery(toolContext, args)),
  );
}

/**
 * One memory_query call: a guarded, scoped read, its facts ordered and cited, followed by the
 * notes the read calls for and a revision receipt. Never throws: a refusal or a failure is the tool
 * error the client sees.
 */
async function handleMemoryQuery(
  { ctx, cap }: ToolContext,
  { query, limit, scopePath, ifRevision }: MemoryQueryArgs,
): Promise<CallToolResult> {
  try {
    // Read-side scope enforcement: the retrieve always carries a `scope`
    // argument, so check() targets the caller's own capability, never the
    // org root by default. Mirrors memory_ingest's default.
    // resolveCallerScopePath (the shared normalizeScopePath +
    // isValidLtreePath guard) falls back to cap.scopePath on an absent or
    // malformed caller-supplied scopePath — safe on a read, which can never
    // return more than the token already covers.
    const target = await resolveCallerScopePath(ctx, scopePath, cap, { onInvalid: "fallback" });
    // With RETRIEVAL_QUERY_SHAPES on, an aggregate question is served compact dated snippets,
    // and an advice question also the person's stated preferences (services/memory/query-shapes.ts).
    // Off, the shape is null and this read is exactly the one it always was.
    const shape = answerShapeOfQuery(query);
    // With RETRIEVAL_AGGREGATE_DIGEST on, an aggregate question's page is chosen for counting
    // and laid out by day (services/memory/aggregate-digest.ts), whatever RETRIEVAL_QUERY_SHAPES says.
    const digest = aggregateDigestOfQuery(query);
    const read = await guardedMemory.retrieve(
      ctx,
      { groupId: ctx.orgId, query, limit },
      target,
      digest
        ? { checkNamedValues: true, compactAggregate: true, aggregateDigest: true }
        : shape === "aggregate"
          ? { checkNamedValues: true, compactAggregate: true }
          : { checkNamedValues: true },
    );
    const { unheldValues } = read;
    // A later record that states a new value of the first line's thing is served above it,
    // and the first line is marked; done here, where the mark is printed, so no caller of
    // retrieve gets an order it cannot explain. Order only: the facts served are the ones
    // the named-value check was squared with.
    // A rule's text stored as a fact is served in the rule's standing: settled rules before
    // leads, each line saying which (services/memory/rule-copies.ts).
    const ruled = await settledRuleCopiesFirst(ctx.orgId, read.facts);
    const facts = serveLaterUpdatesFirst(ruled, query, rankingLeadsApart(provenanceRank));
    // A served record saying the asked-about thing never happened, beside served records that
    // mention it, is reported for the person to settle, never settled here (never-claims.ts).
    const neverNotes = neverClaimConflicts(facts, query)
      .map((c) => `\n\n${neverClaimNote(c.claim, c.mentions, c.example, query)}`)
      .join("");
    // Checked over all memory the caller can read, not this page (services/memory/readable-values.ts).
    const noMatchNote = unheldValues?.length ? `\n\n${NO_READABLE_MATCH_NOTE}` : "";
    const incompleteNotes = incompleteReadNotes(read)
      .map((note) => `\n\n${note}`)
      .join("");
    // Read only now, after check() allowed this read on `target` (guardedMemory.retrieve
    // throws otherwise), so the scope it names is one the caller may read. On every
    // completed read, an empty one too: what the grant covers matters most when it served nothing.
    const scopeNote = await checkedScopeNoteFor(ctx.orgId, target);
    const checkedNote = scopeNote ? `\n\n${scopeNote}` : "";
    // Only on a page with records: it vouches for what was served, never for an absence.
    const grantNote = facts.length ? `\n\n${READ_GRANT_NOTE}` : "";
    const markers = await derivedMarkersFor(ctx, facts.flatMap(storedVersionsBehind));
    const lines = await formatCitedFactLines(ctx.orgId, facts, markers);
    const lineOf = new Map(facts.map((f, i) => [f, lines[i]!]));
    const answer = !facts.length
      ? "No facts found."
      : digest
        ? digestText(digestDays(facts), (f) => lineOf.get(f)!)
        : lines.join("\n");
    // The preference read is a second guarded read of the same scope: check() gates and audits
    // it, and it serves only rows that read may serve.
    const preferences =
      shape === "advice"
        ? preferenceBlock(
            [
              ...(
                await guardedMemory.retrieve(ctx, { groupId: ctx.orgId, query: preferenceQuery(query), limit }, target)
              ).facts,
              ...facts,
            ],
            query,
          )
        : null;
    const served = preferences ? [...facts, ...preferences.facts.filter((f) => !facts.includes(f))] : facts;
    await recordServedFacts(cap, served, target);
    const preferenceText = preferences ? `${preferences.text}\n\n` : "";
    return withRevisionReceipt("memory_query", { orgId: ctx.orgId, target, query, limit }, ifRevision, {
      content: [
        {
          type: "text" as const,
          text: `${preferenceText}${answer}${neverNotes}${noMatchNote}${incompleteNotes}${checkedNote}${grantNote}`,
        },
      ],
      ...(unheldValues ? { _meta: { [UNHELD_VALUES_META_KEY]: unheldValues } } : {}),
    });
  } catch (e) {
    return toolError(e);
  }
}
