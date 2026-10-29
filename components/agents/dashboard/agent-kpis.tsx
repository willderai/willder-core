"use client";

// The agents dashboard's top row: how many agents, how many runs, how they ended,
// what agents were allowed and denied, and how many facts they wrote
// (GET /api/agents/dashboard). Each tile's numbers share one denominator, and a
// number the caller may not see is said to be hidden, never shown as zero.
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { EYEBROW } from "@/components/agents/agent-ui";

type RunCounts = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  waiting: number;
  stalled: number;
};

export type DashboardNumbers = {
  windowDays: number;
  agents: { own: { total: number; active: number }; connected: { total: number; live: number } | null };
  runs: { day: RunCounts; week: RunCounts };
  decisions: { allowed: number; denied: number } | null;
  factsWritten: number;
};

const n = (value: number) => value.toLocaleString();

function Tile({
  label,
  value,
  wide = false,
  children,
}: {
  label: string;
  value: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={`flex min-w-0 flex-col gap-1 p-4 sm:p-5 ${wide ? "col-span-2 lg:col-span-1" : ""}`}>
      <p className={EYEBROW}>{label}</p>
      <p className="text-2xl font-semibold leading-tight tracking-tight tabular-nums text-fg">{value}</p>
      <div className="text-sm leading-snug text-fg-muted">{children}</div>
    </Card>
  );
}

/** The five tiles for numbers already loaded. */
export function AgentKpiTiles({ numbers }: { numbers: DashboardNumbers }) {
  const { agents, runs, decisions, factsWritten, windowDays } = numbers;
  const week = runs.week;
  const blocked = week.waiting + week.stalled;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      <Tile label="Agents on" value={n(agents.own.active)}>
        <p>of {n(agents.own.total)} in this org</p>
        <p className="text-fg-subtle">
          {agents.connected
            ? `${n(agents.connected.live)} of ${n(agents.connected.total)} connected hold a live token`
            : "Connected agents: admins only"}
        </p>
      </Tile>
      <Tile label="Runs, 24 hours" value={n(runs.day.total)}>
        <p>
          {n(week.total)} in {windowDays} days
        </p>
        <p className="text-fg-subtle">{n(runs.day.running + runs.day.waiting)} live now</p>
      </Tile>
      <Tile label={`Outcomes, ${windowDays} days`} value={`${n(week.completed)} done`}>
        <p>
          <span className="text-danger">{n(week.failed)} failed</span> · {n(blocked)} blocked
        </p>
        <p className="text-fg-subtle">of {n(week.total)} runs</p>
      </Tile>
      <Tile label={`Agent access, ${windowDays} days`} value={decisions ? `${n(decisions.allowed)} allowed` : "Hidden"}>
        {decisions ? (
          <>
            <p>
              <span className="text-danger">{n(decisions.denied)} denied</span>
            </p>
            <p className="text-fg-subtle">of {n(decisions.allowed + decisions.denied)} decisions</p>
          </>
        ) : (
          <p className="text-fg-subtle">Only org admins see the audit log.</p>
        )}
      </Tile>
      <Tile label={`Facts written, ${windowDays} days`} value={n(factsWritten)} wide>
        <p className="text-fg-subtle">by agents, in scopes you can read</p>
      </Tile>
    </div>
  );
}

/** The tiles, loading their numbers once. */
export function AgentKpis() {
  const [numbers, setNumbers] = useState<DashboardNumbers | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/agents/dashboard", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/agents/dashboard failed: ${res.status}`);
        const body: DashboardNumbers = await res.json();
        if (!body?.runs?.week || !body.agents?.own) throw new Error("GET /api/agents/dashboard returned no numbers");
        setNumbers(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load the agent numbers. Reload to try again.
      </p>
    );
  }
  if (!numbers) {
    return (
      <div role="status" aria-label="Loading agent numbers" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-28 rounded-2xl border border-divider bg-fg/[0.03] motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }
  return <AgentKpiTiles numbers={numbers} />;
}
