"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// null means the count is unknown: the server could not run it, or the poll
// failed. The nav shows no badge for it rather than a number nobody measured.
export type NavBadges = {
  "/agents": number | null;
  "/memory": number | null;
};

const EMPTY: NavBadges = { "/agents": 0, "/memory": 0 };
const UNKNOWN: NavBadges = { "/agents": null, "/memory": null };
const countOrNull = (value: unknown) => (typeof value === "number" ? value : null);
const POLL_MS = 30_000;
const TRACKED = ["/agents", "/memory"] as const;

// Track last-visit timestamps per route in localStorage so "new since last visit"
// badges reset when the user visits the page.
const VISIT_KEY = "willder:nav:lastVisit";

function getLastVisits(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VISIT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function setLastVisit(href: string) {
  try {
    const visits = getLastVisits();
    visits[href] = new Date().toISOString();
    localStorage.setItem(VISIT_KEY, JSON.stringify(visits));
  } catch {
    /* ignore */
  }
}

export function useNavBadges(): NavBadges {
  const [badges, setBadges] = useState<NavBadges>(EMPTY);
  const pathname = usePathname();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear that page's badge when the user navigates to it (adjusted during
  // render on each pathname change) and record the visit (a side effect, so
  // it stays in an effect).
  const visitMatch = TRACKED.find((h) => pathname.startsWith(h));
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  if (pathname !== clearedFor) {
    setClearedFor(pathname);
    if (visitMatch) setBadges((prev) => ({ ...prev, [visitMatch]: 0 }));
  }
  useEffect(() => {
    if (visitMatch) setLastVisit(visitMatch);
  }, [pathname, visitMatch]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const visits = getLastVisits();
      // "New since last visit" is only asked for Memory, so its own last visit is the
      // `since` param.
      const since = visits["/memory"] ?? null;

      const url = since ? `/api/nav/badges?since=${encodeURIComponent(since)}` : `/api/nav/badges`;

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`nav badges answered ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setBadges({
            "/agents": countOrNull(data.activeAgentRuns),
            "/memory": countOrNull(data.newMemoryChunks),
          });
        }
      } catch {
        // A failed poll leaves no count to vouch for; the next poll tries again.
        if (!cancelled) setBadges(UNKNOWN);
      }

      if (!cancelled) {
        timerRef.current = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return badges;
}
