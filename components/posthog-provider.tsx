"use client";

import type { PostHog } from "posthog-js";
import { createContext, useContext, useEffect, useState } from "react";

// Keep the provider stable while its optional SDK loads, so an analytics
// update never remounts the application or resets a form in progress.
const AnalyticsContext = createContext<PostHog | undefined>(undefined);

export function useAnalytics() {
  return useContext(AnalyticsContext);
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<PostHog>();

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

    let active = true;
    const initialize = () => {
      void import("posthog-js")
        .then(({ default: posthog }) => {
          if (!active) return;
          posthog.init(key, {
            api_host: "/ingest",
            ui_host: "https://us.posthog.com",
            capture_pageview: "history_change",
            capture_pageleave: true,
            // Uncaught browser errors go to PostHog error tracking with the rest.
            capture_exceptions: true,
          });
          setClient(posthog);
        })
        .catch(() => {
          // Analytics is optional; blocked telemetry must not interrupt the UI.
        });
    };
    const supportsIdle = typeof window.requestIdleCallback === "function";
    const handle = supportsIdle
      ? window.requestIdleCallback(initialize, { timeout: 3000 })
      : window.setTimeout(initialize, 200);
    return () => {
      active = false;
      if (supportsIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  return <AnalyticsContext.Provider value={client}>{children}</AnalyticsContext.Provider>;
}
