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

  // Record visit and clear that page's badge when the user navigates to it
  useEffect(() => {
    const tracked = ["/agents", "/memory"] as const;
    const match = tracked.find((h) => pathname.startsWith(h));
    if (match) {
      setLastVisit(match);
      setBadges((prev) => ({ ...prev, [match]: 0 }));
    }
  }, [pathname]);

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
