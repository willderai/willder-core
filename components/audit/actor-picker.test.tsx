// @vitest-environment jsdom
//
// Regression test: ActorPicker must not key its selection off actorId alone
// (`selected: string | null`, `actors.find(a => a.actorId === selected)`). A
// human User.id and an agent capability agentKey/agentId are not guaranteed
// disjoint namespaces, so if the two ever shared the same id string, the
// picker would silently resolve to whichever actor happened to come first in
// the list — selecting one identity could display, and filter by, the other.
// `selected`/`onChange` carry the full
// (actorType, actorId) pair; this pins that a human and an agent sharing
// the same actorId string never merge or cross-match in the picker itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActorPicker } from "./actor-picker";

const SHARED_ID = "shared_synthetic_id";
const ACTORS = [
  { actorType: "human", actorId: SHARED_ID, name: "Human Sam (synthetic)" },
  { actorType: "agent", actorId: SHARED_ID, name: "Agent Sam (synthetic)" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubActorsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ actors: ACTORS }), { status: 200 })),
  );
}

describe("ActorPicker — actorId alone does not identify an actor", () => {
  it("selecting the agent row (not the human row) sharing the same actorId reports the agent's composite key", async () => {
    stubActorsFetch();
    const onChange = vi.fn();
    render(<ActorPicker selected={null} onChange={onChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));
    fireEvent.click(await screen.findByText("Agent Sam (synthetic)"));

    expect(onChange).toHaveBeenCalledWith({ actorType: "agent", actorId: SHARED_ID });
    expect(onChange).not.toHaveBeenCalledWith({ actorType: "human", actorId: SHARED_ID });
  });

  it("selecting the human row (not the agent row) sharing the same actorId reports the human's composite key", async () => {
    stubActorsFetch();
    const onChange = vi.fn();
    render(<ActorPicker selected={null} onChange={onChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));
    fireEvent.click(await screen.findByText("Human Sam (synthetic)"));

    expect(onChange).toHaveBeenCalledWith({ actorType: "human", actorId: SHARED_ID });
    expect(onChange).not.toHaveBeenCalledWith({ actorType: "agent", actorId: SHARED_ID });
  });

  it("a selection naming the agent half of the shared id displays the agent's name, not the human's", async () => {
    stubActorsFetch();
    render(<ActorPicker selected={{ actorType: "agent", actorId: SHARED_ID }} onChange={() => {}} />);

    expect(await screen.findByText("Agent Sam (synthetic)")).toBeTruthy();
    expect(screen.queryByText("Human Sam (synthetic)")).toBeNull();
  });
});
