// @vitest-environment jsdom
//
// FactCard's DELETE and PATCH calls must carry the selected scope, not send
// none at all: facts/[id]/route.ts otherwise defaults to org root regardless
// of which scope the fact actually lives under — a delete authorized only at
// a narrower scope could miss the real (differently-partitioned) Graphiti
// record, and a PATCH's re-ingest would silently land the corrected fact at a
// broader scope than the original. The same coverage gap applies to
// upload-button.test.tsx for the upload branch: the selected `scope` state
// (ScopePicker) must thread to ask()/submitFact()/UploadButton in
// memory-workbench.tsx, and to FactCard's own two verbs as well.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { FactCard } from "./memory-workbench";
import type { MemoryFact } from "@/types/memory";

afterEach(() => {
  vi.unstubAllGlobals();
});

const FACT: MemoryFact = { uuid: "fact_1", fact: "Deal A: budget is $50k", validAt: null, actorType: "human" };

describe("FactCard.remove — scope forwarding", () => {
  it("appends the selected scope as a ?scope= query param on DELETE", async () => {
    let sentUrl: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sentUrl = url;
        return new Response(JSON.stringify({ removed: "fact_1" }), { status: 200 });
      }),
    );

    const onRemoved = vi.fn();
    const { getByText } = render(
      <FactCard
        fact={FACT}
        scope="org_1.dealA"
        canDelete={true}
        canWrite={true}
        onRemoved={onRemoved}
        onEdited={() => {}}
        onNote={() => {}}
      />,
    );

    fireEvent.click(getByText("remove"));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("fact_1"));
    expect(sentUrl).toBe("/api/memory/facts/fact_1?scope=org_1.dealA");
  });

  it("omits the scope query param entirely when no scope is selected", async () => {
    let sentUrl: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sentUrl = url;
        return new Response(JSON.stringify({ removed: "fact_1" }), { status: 200 });
      }),
    );

    const onRemoved = vi.fn();
    const { getByText } = render(
      <FactCard
        fact={FACT}
        scope={null}
        canDelete={true}
        canWrite={true}
        onRemoved={onRemoved}
        onEdited={() => {}}
        onNote={() => {}}
      />,
    );

    fireEvent.click(getByText("remove"));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("fact_1"));
    expect(sentUrl).toBe("/api/memory/facts/fact_1");
  });
});

// A fact longer than a read's whole token budget reaches the Ask screen as an excerpt
// (services/memory/account-tiers.ts packWithinTokenBudget), with `excerptOfChars` set.
// Its card must still read as the cited, attributed fact it is part of, and must say it
// is partial. It must not offer an edit: a correction replaces the stored fact with the
// text sent (facts/[id]/route.ts PATCH removes, then ingests), so saving an edited
// excerpt would silently drop everything the excerpt left out.
describe("FactCard — a fact served as an excerpt", () => {
  const EXCERPT: MemoryFact = {
    uuid: "fact_long",
    fact: "… The release waits on the payments migration. …",
    validAt: null,
    actorType: "extraction",
    actorName: "acme/platform",
    sourceId: "src_repo",
    excerptOfChars: 92_000,
  };

  function renderExcerpt() {
    return render(
      <FactCard
        fact={EXCERPT}
        citation={1}
        scope="org_1.dealA"
        canDelete={true}
        canWrite={true}
        onRemoved={() => {}}
        onEdited={() => {}}
        onNote={() => {}}
      />,
    );
  }

  it("keeps its [n] citation and its source, and says it is an excerpt of the full length", () => {
    const { container, getByText } = renderExcerpt();

    const text = container.querySelector("p")!.textContent;
    expect(text?.startsWith(`[1]${EXCERPT.fact}`)).toBe(true);
    expect(getByText("acme/platform", { selector: "span" })).toBeTruthy();
    expect(getByText("src_repo")).toBeTruthy();
    expect(getByText("excerpt of 92,000 characters")).toBeTruthy();
  });

  it("offers no edit, so an excerpt can never replace the whole fact", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { queryByText, getByText } = renderExcerpt();

    expect(queryByText("edit")).toBeNull();
    expect(getByText("remove")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("FactCard.saveEdit — scope forwarding", () => {
  it("includes the selected scope in the PATCH body", async () => {
    let sentBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ jobId: "queued" }), { status: 202 });
      }),
    );

    const onEdited = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <FactCard
        fact={FACT}
        scope="org_1.dealA"
        canDelete={true}
        canWrite={true}
        onRemoved={() => {}}
        onEdited={onEdited}
        onNote={() => {}}
      />,
    );

    fireEvent.click(getByText("edit"));
    fireEvent.change(getByDisplayValue(FACT.fact), { target: { value: "Deal A: budget is $60k" } });
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(onEdited).toHaveBeenCalledWith("fact_1", "Deal A: budget is $60k"));
    expect(sentBody).toEqual({ fact: "Deal A: budget is $60k", scope: "org_1.dealA" });
  });
});

describe("FactCard.saveEdit — what the person is told", () => {
  /** Edit FACT through the card against a route answering `status` with `body`. */
  async function editAgainst(status: number, body: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
    const onEdited = vi.fn();
    const onNote = vi.fn();
    const onRemoved = vi.fn();
    const view = render(
      <FactCard
        fact={FACT}
        scope="org_1.dealA"
        canDelete={true}
        canWrite={true}
        onRemoved={onRemoved}
        onEdited={onEdited}
        onNote={onNote}
      />,
    );
    fireEvent.click(view.getByText("edit"));
    fireEvent.change(view.getByDisplayValue(FACT.fact), { target: { value: "Deal A: budget is $60k" } });
    fireEvent.click(view.getByText("Save"));
    return { ...view, onEdited, onNote, onRemoved };
  }

  it("says a queued correction is being extracted", async () => {
    const { onNote } = await editAgainst(202, { jobId: "queued" });
    await waitFor(() => expect(onNote).toHaveBeenCalledWith("Fact corrected — re-extracting into memory…", "ember"));
  });

  it.each([
    [402, "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory"],
    [
      409,
      "This fact (fact_1) was already replaced by v9. Correct v9, the version in force, instead. Nothing was changed.",
    ],
  ])("shows the route's own words for a %i, and does not mark the fact corrected", async (status, error) => {
    const { onEdited, findByText } = await editAgainst(status, { error });
    expect(await findByText(error)).toBeTruthy();
    expect(onEdited).not.toHaveBeenCalled();
  });

  it("marks the fact removed when the route removed it but did not confirm the corrected text, and keeps the text", async () => {
    const error =
      "The fact was removed, but your corrected text was not confirmed as saved. If it does not show in memory within a minute, add it again as a new fact.";
    const { onEdited, onRemoved, findByText, getByDisplayValue, getByText } = await editAgainst(503, {
      error,
      factRemoved: true,
    });
    expect(await findByText(error)).toBeTruthy();
    expect(onRemoved).toHaveBeenCalledWith(FACT.uuid);
    expect(onEdited).not.toHaveBeenCalled();
    expect(getByDisplayValue("Deal A: budget is $60k")).toBeTruthy();
    expect(getByText("Save").closest("button")?.disabled).toBe(true);
    expect(getByText(/Removed from memory/)).toBeTruthy();
  });

  it("leaves the fact in place on a 503 that does not say it was removed", async () => {
    const { onRemoved, findByText } = await editAgainst(503, { error: "memory service unavailable" });
    expect(await findByText("memory service unavailable")).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
