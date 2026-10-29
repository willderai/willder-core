import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render + interaction tests for the architecture options-comparison table
// (components/agents/decision-table.tsx). No DOM library is installed, so we render to
// static markup with react-dom/server for the visual assertions, and — because the
// component is hook-free and purely presentational — walk its element tree to find the
// per-option button and invoke its onClick to prove onChoose(optionId) is wired.
import { DecisionTable } from "./decision-table";
import type { DecisionFragment } from "@/types/agent-run";

const single: DecisionFragment = {
  as: "decision",
  question: "Which datastore?",
  options: [
    { id: "pg", label: "Postgres", pros: "Relational", cons: "Ops", cost: "$" },
    { id: "dynamo", label: "DynamoDB", pros: "Serverless", cons: "Modeling" },
  ],
  recommendation: { optionId: "pg", rationale: "Best fit for relational data at this scale." },
};

const render = (props: Parameters<typeof DecisionTable>[0]) =>
  renderToStaticMarkup(createElement(DecisionTable, props));

// Hook-free tree walk: invoke function components with their props (no state to worry
// about) and collect every host <button>'s props so we can fire its onClick.
type Node = ReactElement | string | number | boolean | null | undefined | Node[];
function collectButtons(node: Node, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) collectButtons(c, out);
    return out;
  }
  const el = node as ReactElement;
  const { type, props } = el as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function") {
    return collectButtons((type as (p: unknown) => Node)(props), out);
  }
  if (type === "button") out.push(props);
  if (props && props.children != null) collectButtons(props.children as Node, out);
  return out;
}

describe("DecisionTable — recommendation flagging", () => {
  it("flags the recommended option with the gold ★ badge and shows its rationale", () => {
    const html = render({ decision: single });
    expect(html).toContain("Recommended");
    expect(html).toContain("★");
    expect(html).toContain("Best fit for relational data at this scale.");
    // Header frames the recommendation as a suggestion, not a locked decision.
    expect(html).toContain("suggestion, not a decision");
    // Both option labels render.
    expect(html).toContain("Postgres");
    expect(html).toContain("DynamoDB");
  });

  it("renders every option's default action button as 'Choose this' when nothing is chosen", () => {
    const html = render({ decision: single });
    expect(html).toContain("Choose this");
    expect(html).not.toContain("Your choice");
  });
});

describe("DecisionTable — chosen option", () => {
  it("renders the human's chosenOptionId distinctly (badge + confirmed button) and updates the header", () => {
    const html = render({ decision: { ...single, chosenOptionId: "dynamo" } });
    expect(html).toContain("Your choice");
    expect(html).toContain("Chosen");
    // (apostrophe is HTML-escaped by renderToStaticMarkup)
    expect(html).toContain("made this call.");
    // The recommendation badge still renders for reference (may differ from the pick).
    expect(html).toContain("Recommended");
  });
});

describe("DecisionTable — arity", () => {
  it("handles a single DecisionFragment", () => {
    const html = render({ decision: single });
    expect(html).toContain("Which datastore?");
  });

  it("handles an array of DecisionFragments (renders each question)", () => {
    const second: DecisionFragment = {
      as: "decision",
      question: "Which queue?",
      options: [
        { id: "sqs", label: "SQS" },
        { id: "kafka", label: "Kafka" },
      ],
      recommendation: { optionId: "sqs", rationale: "Simplest for this volume." },
    };
    const html = render({ decision: [single, second] });
    expect(html).toContain("Which datastore?");
    expect(html).toContain("Which queue?");
  });

  it("renders a friendly empty state for an empty array", () => {
    const html = render({ decision: [] });
    expect(html).toContain("No decisions to compare yet.");
  });
});

describe("DecisionTable — onChoose", () => {
  it("calls onChoose with the option id when an option's button is activated", () => {
    const onChoose = vi.fn();
    const el = DecisionTable({ decision: single, onChoose }) as unknown as Node;
    const buttons = collectButtons(el);
    expect(buttons).toHaveLength(2); // one per option
    (buttons[0].onClick as () => void)();
    expect(onChoose).toHaveBeenCalledWith("pg");
    (buttons[1].onClick as () => void)();
    expect(onChoose).toHaveBeenCalledWith("dynamo");
  });

  it("defaults onChoose to a no-op — activating a button does not throw when none is passed", () => {
    const el = DecisionTable({ decision: single }) as unknown as Node;
    const buttons = collectButtons(el);
    expect(() => (buttons[0].onClick as () => void)()).not.toThrow();
  });
});
