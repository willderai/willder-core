// The facts an agent actually retrieved during a run, and the short labels it cites them by.
//
// A model asked to cite facts by uuid copies uuids badly, and a citation it invents points
// at nothing. So the run records what `memory_read` really returned (tools.ts), gives each
// fact a label such as F3, shows the model those labels, and maps the labels it cites back
// to the recorded facts. The rule this file enforces: a citation can only name a fact this
// run retrieved; any other label is dropped.
import type { BriefCitationInput } from "@/services/memory/brief-citations";

/** Most retrieved facts listed for the model to cite; the first ones retrieved are kept. */
export const MAX_LABELLED_FACTS = 80;

/** One fact as `memory_read` returned it. */
export interface RetrievedFact {
  uuid: string;
  fact: string;
}

/** Collects the facts a run retrieved, in first-retrieved order, one entry per uuid. */
export class RetrievedFacts {
  private readonly facts = new Map<string, RetrievedFact>();

  /** Record facts a `memory_read` call returned. */
  add(facts: RetrievedFact[]): void {
    for (const fact of facts) {
      if (this.facts.size === MAX_LABELLED_FACTS) return;
      if (!this.facts.has(fact.uuid)) this.facts.set(fact.uuid, { uuid: fact.uuid, fact: fact.fact });
    }
  }

  /** The labelled list shown to the model, one `[F1] text` line per fact. Empty when nothing was retrieved. */
  promptBlock(): string {
    return this.labelled()
      .map(({ label, fact }) => `[${label}] ${fact.fact.replace(/\s+/g, " ").trim()}`)
      .join("\n");
  }

  /**
   * The citations a structured output names, as facts this run retrieved. A label
   * that names no retrieved fact is dropped, never guessed at.
   */
  citationsFor(sections: { citations?: string[] }[]): BriefCitationInput[] {
    const byLabel = new Map(this.labelled().map(({ label, fact }) => [label, fact]));
    return sections.flatMap((section, sectionIndex) =>
      (section.citations ?? []).flatMap((label) => {
        const fact = byLabel.get(
          label
            .trim()
            .replace(/^\[|\]$/g, "")
            .toUpperCase(),
        );
        return fact ? [{ sectionIndex, factId: fact.uuid, factText: fact.fact }] : [];
      }),
    );
  }

  private labelled(): { label: string; fact: RetrievedFact }[] {
    return [...this.facts.values()].map((fact, i) => ({ label: `F${i + 1}`, fact }));
  }
}
