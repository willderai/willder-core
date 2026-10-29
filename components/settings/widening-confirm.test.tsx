// @vitest-environment jsdom
//
// The confirmation question says an unknown number of people when the source
// reported no bound (atMost 0), never "up to 0 more people".
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WideningConfirm, type PendingWidening } from "./widening-confirm";

afterEach(cleanup);

function question(widening: PendingWidening["widening"]) {
  render(
    <WideningConfirm
      pending={{
        body: {},
        widening,
        acknowledge: { people: widening.status === "known" ? widening.people : "unknown", agents: widening.agents },
      }}
      what="this repository"
      busy={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  return screen.getByRole("alertdialog").textContent ?? "";
}

describe("WideningConfirm wording", () => {
  it("says the people count is unknown when no bound is known", () => {
    const text = question({ status: "unknown", atMost: 0, agents: 2 });
    expect(text).toContain("an unknown number of people could read it through Willder, and 2 agents will");
    expect(text).not.toMatch(/up to 0|0 more people/);
  });

  it("keeps the bound when one is known", () => {
    expect(question({ status: "unknown", atMost: 4, agents: 0 })).toContain("up to 4 more people could read it");
  });
});
