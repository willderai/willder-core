"use client";

import { useSyncExternalStore } from "react";

// Nothing to subscribe to: whether we are on the client never changes after
// hydration, so the store only has to answer the server/client question.
function subscribe() {
  return () => {};
}

/**
 * False during server render and hydration, true afterwards. Replaces the
 * `useState(false)` + `useEffect(() => setMounted(true))` idiom for markup
 * that must not render on the server (portals, theme-dependent icons): React
 * re-renders with the client snapshot right after hydration, without the
 * extra setState-in-effect pass.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
