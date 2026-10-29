"use client";

import { useEffect, useRef } from "react";
import type { ServerPageState } from "@/components/list-controls/use-server-page";

// Integrations lists sources in two panels, Knowledge sources and Connectors, and each loads
// /api/sources itself. After one panel connects, syncs or disconnects a source, it announces
// the change here so the other panel reloads instead of showing the old state until a page
// reload.

const SOURCES_CHANGED = "willder:sources-changed";

/** The panel that wrote, named as a person reads it ("Connectors", "Knowledge sources"). */
type Panel = string;

/** Tell every other sources panel on the page that a source was written. */
export function announceSourcesChanged(from: Panel): void {
  window.dispatchEvent(new CustomEvent<Panel>(SOURCES_CHANGED, { detail: from }));
}

/** Call `onChange` with the writing panel's name when another panel writes a source. */
export function useSourcesChanged(self: Panel, onChange: (from: Panel) => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const from = (event as CustomEvent<Panel>).detail;
      if (from !== self) latest.current(from);
    };
    window.addEventListener(SOURCES_CHANGED, listener);
    return () => window.removeEventListener(SOURCES_CHANGED, listener);
  }, [self]);
}

/**
 * A line a sources panel shows above its list: the result of a write it made
 * ("#general disconnected. Removed 2 facts…"), or that it reloaded after a write in
 * the other panel ("Updated after a change in Connectors.").
 */
export type SourcesNotice = { text: string; kind: "write" | "changed-elsewhere" };

/**
 * Whether `notice` shows beside a list in `status`. Every notice follows a reload, and
 * none shows while that reload is in flight, so a line never sits beside the rows it
 * says changed. A write's result still shows when the reload then fails, because the
 * write happened; "updated after a change" shows only beside a list that did update.
 */
export function showsNotice(
  notice: SourcesNotice | null,
  status: ServerPageState<unknown>["status"],
): notice is SourcesNotice {
  if (notice === null || status === "loading") return false;
  return notice.kind === "write" || status === "ready";
}
