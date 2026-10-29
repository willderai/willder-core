"use client";

// The agent tokens holding `admin` right now, each with the time left in its window
// and a revoke button. Admin on an agent token lasts at most two hours from issue,
// enforced by the server on every call; the countdown here only shows that, so a
// person can see an open window and close it early.

import { useEffect, useState } from "react";
import { Card, Pill } from "@/components/ui";

/** An agent token as GET /api/access/capabilities lists it. */
export interface AdminToken {
  id: string;
  agentId: string;
  scopePath: string;
  expiresAt: string;
}

/** How long is left until `expiresAt`, as "1h 05m 09s"; "closing" once it has passed. */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "closing";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

export function AdminWindowCard({ tokens, onRevoke }: { tokens: AdminToken[]; onRevoke: (id: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tokens.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tokens.length]);

  if (tokens.length === 0) return null;
  return (
    <section aria-label="Active admin windows" className="mt-6">
      <Card glow="ember" className="p-5">
        <p className="text-eyebrow font-semibold uppercase text-ember">Admin window open</p>
        <p className="mt-1 text-sm text-fg-muted">
          These agents hold admin. Each window closes two hours after it was issued and cannot be extended.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Pill dot="brick">admin</Pill>
                <span className="font-mono text-sm text-fg">{t.agentId}</span>
                <span className="font-mono text-xs text-fg-subtle">{t.scopePath}</span>
              </span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-sm tabular-nums text-fg" aria-live="off">
                  {timeLeft(t.expiresAt, now)} left
                </span>
                <button
                  onClick={() => onRevoke(t.id)}
                  className="text-sm font-semibold capitalize text-danger underline-offset-4 hover:underline"
                >
                  revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
