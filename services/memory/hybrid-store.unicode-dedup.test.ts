// Deduplication must not depend on the script a fact is written in.
//
// HybridMemoryStore.dedup() keys facts on a normalised form. That normaliser
// used an ASCII allowlist (`[^a-z0-9 ]` -> " "), so every fact written in
// Chinese, Japanese, Korean, Cyrillic, Greek, Arabic or Hebrew normalised to
// the empty string, shared one key, and a hybrid read kept only the first of
// them. These tests pin the script-agnostic replacement: distinct non-Latin
// facts survive a read, and genuine duplicates still collapse.
import { describe, expect, it, vi } from "vitest";
import { HybridMemoryStore } from "./hybrid-store";
import type { MemoryStore } from "./memory-store";
import type { SearchInput } from "@/types/memory";

function storeOf(facts: string[]): MemoryStore {
  return {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-1" }),
    retrieve: vi.fn().mockResolvedValue({
      facts: facts.map((fact, i) => ({ uuid: `u${i}`, fact, validAt: null })),
    }),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn().mockResolvedValue({ removed: true }),
    removeEntity: vi.fn().mockResolvedValue({ removed: false }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 0 }),
  } as unknown as MemoryStore;
}

const SEARCH: SearchInput = { groupId: "org_1", query: "what have we discussed" };

/** The facts a hybrid read returns when the graph leg holds `graph` and the vector leg holds `vector`. */
async function read(graph: string[], vector: string[]): Promise<string[]> {
  const store = new HybridMemoryStore(storeOf(graph), storeOf(vector));
  const result = await store.retrieve(SEARCH);
  return result.facts.map((f) => f.fact);
}

describe("HybridMemoryStore dedup — facts outside the Latin script", () => {
  const CASES: Array<[script: string, a: string, b: string]> = [
    ["Chinese", "定价策略已经确定。", "会议安排在周五下午。"],
    ["Cyrillic", "Цена утверждена советом.", "Встреча перенесена на пятницу."],
    ["Greek", "Η τιμή εγκρίθηκε από το συμβούλιο.", "Η συνάντηση μετατέθηκε για την Παρασκευή."],
    ["Japanese", "価格は確定しました。", "会議は金曜日です。"],
    ["Korean", "가격이 확정되었습니다.", "회의는 금요일입니다."],
    ["Arabic", "تم اعتماد السعر.", "تم تأجيل الاجتماع إلى الجمعة."],
    ["Hebrew", "המחיר אושר.", "הפגישה נדחתה ליום שישי."],
  ];

  it.each(CASES)("keeps two different %s facts, one per store", async (_script, a, b) => {
    expect(await read([a], [b])).toEqual([a, b]);
  });

  it.each(CASES)("keeps two different %s facts arriving in the same store", async (_script, a, b) => {
    expect(await read([a, b], [])).toEqual([a, b]);
  });

  it("keeps seven facts in seven different scripts in one read", async () => {
    const facts = CASES.map(([, a]) => a);
    expect(await read(facts, [])).toEqual(facts);
  });

  it("tells an emoji-bearing fact from the otherwise identical one beside it", async () => {
    // Emoji are symbols, not punctuation, so they are content: "shipped 🚀" and
    // "shipped 🔥" are two claims, and neither collapses into the plain one.
    const facts = ["Release shipped 🚀", "Release shipped 🔥", "Release shipped"];
    expect(await read(facts, [])).toEqual(facts);
  });

  it("keeps two facts that are nothing but different emoji", async () => {
    expect(await read(["🚀", "🎉"], [])).toEqual(["🚀", "🎉"]);
  });

  it("keeps two facts that are nothing but different punctuation", async () => {
    // Punctuation-only text normalises to nothing, so the normaliser falls back
    // to the text itself rather than dropping every such fact onto one key.
    expect(await read(["...", "???"], [])).toEqual(["...", "???"]);
  });
});

describe("HybridMemoryStore dedup — genuine duplicates still collapse", () => {
  it("collapses the same Chinese claim appearing in both stores", async () => {
    expect(await read(["定价策略已经确定。"], ["定价策略已经确定。"])).toEqual(["定价策略已经确定。"]);
  });

  it("collapses the same Chinese claim across full-width and half-width punctuation", async () => {
    expect(await read(["定价策略已经确定。"], ["定价策略已经确定!"])).toHaveLength(1);
  });

  it("collapses the same Cyrillic claim across case and trailing punctuation", async () => {
    expect(await read(["Цена утверждена советом."], ["цена утверждена советом"])).toHaveLength(1);
  });

  it("collapses the same Greek claim across case", async () => {
    expect(await read(["Η ΤΙΜΗ ΕΓΚΡΙΘΗΚΕ"], ["η τιμη εγκριθηκε"])).toHaveLength(1);
  });

  it("collapses the same ASCII claim across case, punctuation and spacing, as before", async () => {
    expect(await read(["Pricing is   approved!"], ["pricing is approved"])).toHaveLength(1);
  });

  it("collapses a claim whose only difference is a non-breaking space", async () => {
    expect(await read(["pricing is approved"], ["pricing is approved"])).toHaveLength(1);
  });
});
