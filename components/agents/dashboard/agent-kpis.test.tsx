// @vitest-environment jsdom
//
// Every tile's numbers share one denominator, and a number the caller may not see
// reads as hidden, never as zero.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentKpiTiles, type DashboardNumbers } from "./agent-kpis";

const counts = (total: number, failed: number) => ({
  total,
  completed: total - failed - 2,
  failed,
  running: 1,
  waiting: 1,
  stalled: 0,
});
const numbers = (over: Partial<DashboardNumbers> = {}): DashboardNumbers => ({
  windowDays: 7,
  agents: { own: { total: 4, active: 3 }, connected: { total: 5, live: 2 } },
  runs: { day: counts(12, 1), week: counts(1_240, 31) },
  decisions: { allowed: 4_990, denied: 9 },
  factsWritten: 87,
  ...over,
});

afterEach(cleanup);

describe("agent number tiles", () => {
  it("shows denied beside allowed over the same decisions, and failed of the same runs", () => {
    render(<AgentKpiTiles numbers={numbers()} />);
    expect(screen.getByText("4,990 allowed")).toBeTruthy();
    expect(screen.getByText("9 denied")).toBeTruthy();
    expect(screen.getByText("of 4,999 decisions")).toBeTruthy();
    expect(screen.getByText("31 failed")).toBeTruthy();
    expect(screen.getByText("of 1,240 runs")).toBeTruthy();
    expect(screen.getByText("2 of 5 connected hold a live token")).toBeTruthy();
  });

  it("says the audit numbers and connected agents are hidden from a member, never zero", () => {
    render(
      <AgentKpiTiles
        numbers={numbers({ decisions: null, agents: { own: { total: 4, active: 3 }, connected: null } })}
      />,
    );
    expect(screen.getByText("Hidden")).toBeTruthy();
    expect(screen.getByText("Only org admins see the audit log.")).toBeTruthy();
    expect(screen.getByText("Connected agents: admins only")).toBeTruthy();
    expect(screen.queryByText(/0 denied/)).toBeNull();
  });
});
