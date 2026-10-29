// Which of a task's served facts conflict, so the task-start block serves them together and asks
// the person which holds (mcp/task-start-notice.ts).
//
// Two served facts conflict when they are versions of one fact, the same entity name in the same
// scope (the contention key of services/memory/conflict.ts), stored by different writers (its
// writer rule, `sameWriter`), and their texts differ. Every version of that fact the block was
// handed then belongs to one conflicting set. This is the store's own signal, not a reading of
// the words: two versions that agree in different words still differ, and two facts under
// different names that contradict each other are not found here.
//
// The one rule this file enforces: a conflict is never decided here. A set holds every version
// the read handed over, none marked as the one that holds. A version the winner rule retired
// (`retired`), and one read only because it shares a served fact's name (`partner`), are kept
// only inside a conflicting set; on their own they are history, and are left out as before.
import { sameWriter, type StoredWriter } from "./conflict";

/** What this file reads of a served fact. */
export interface ConflictCandidate {
  id: string;
  entityName: string | null;
  content: string;
  role: string | null;
  writtenAt?: string;
  /** The scope the version is stored in; a fact without one never conflicts. */
  scopePath?: string;
  /** Who stored the version, as `memory_chunks` records it; absent reads as an unknown writer. */
  writer?: StoredWriter;
  /** Set when the winner rule retired this version: a lost conflict. */
  retired?: true;
  /** Set when the version was read only because it shares a served fact's name and scope. */
  partner?: true;
}

/** The facts to serve, and the conflicting set each conflicting one belongs to. */
export interface ServedConflicts<T> {
  /** `facts` in their order, less every retired or partner version outside a conflicting set. */
  facts: T[];
  /** The key of the conflicting set, by fact id; a fact in no set is absent. */
  setOf: Map<string, string>;
}

const UNKNOWN_WRITER: StoredWriter = { actorId: null, actorType: "" };

/** Text as compared: lower case, every run of characters that are not letters or digits one space. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The conflicting sets among `facts`, and `facts` without the retired and partner versions no set
 * holds. The parts of one write (stored at one instant, under one name and role, by one writer)
 * are compared as one text.
 */
export function servedConflicts<T extends ConflictCandidate>(facts: readonly T[]): ServedConflicts<T> {
  const byFact = new Map<string, T[]>();
  for (const fact of facts) {
    if (!fact.entityName || fact.scopePath === undefined) continue;
    const key = `${fact.scopePath}\u0000${fact.entityName}`;
    byFact.set(key, [...(byFact.get(key) ?? []), fact]);
  }

  const setOf = new Map<string, string>();
  for (const [key, versions] of byFact) {
    const writes = new Map<string, { writer: StoredWriter; texts: string[] }>();
    for (const version of versions) {
      const writer = version.writer ?? UNKNOWN_WRITER;
      // One write's parts share an instant, a role and a writer; a version with no instant is a write of its own.
      // A version with no recorded writer id is a write of its own, as conflict.ts's writer rule says.
      const write =
        version.writtenAt === undefined || !writer.actorId?.trim()
          ? version.id
          : `${version.writtenAt}\u0000${version.role}\u0000${writer.actorType}\u0000${writer.actorId}`;
      const entry = writes.get(write) ?? { writer, texts: [] };
      entry.texts.push(version.content);
      writes.set(write, entry);
    }
    const compared = [...writes.values()].map(({ writer, texts }) => ({ writer, text: comparable(texts.join(" ")) }));
    const conflicting = compared.some((a, i) =>
      compared.slice(i + 1).some((b) => !sameWriter(a.writer, b.writer) && a.text !== b.text),
    );
    if (conflicting) for (const version of versions) setOf.set(version.id, key);
  }

  return { facts: facts.filter((fact) => setOf.has(fact.id) || (!fact.retired && !fact.partner)), setOf };
}
