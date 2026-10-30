"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraph, MemoryEdge, MemoryNode, MemoryEntity } from "@/types/memory";
import { displayWriterLabel } from "@/components/audit/format";

type Pos = { x: number; y: number };

const W = 900;
const H = 540;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

// Past this zoom level, thinning stops applying: zooming in is the user
// asking to see a specific area closely, and it naturally narrows how many
// nodes are on screen, so revealing their names is the zoom half of
// progressive disclosure (Obsidian/Roam/Neo4j Bloom's own pattern). Doesn't
// touch LABEL_DENSITY_THRESHOLD or selectLabeledNodeIds — this is an
// additional reveal layered on top of their unchanged output, not a change
// to the thinning gate itself.
const ZOOM_LABEL_REVEAL = 2;

// Frame a finished layout: zoom out (never in) so the whole bounding box fits,
// then centre it. Keeps small scopes at 100% (their existing feel) while large
// scopes that spread past the frame get pulled back into view.
function fitView(pos: Record<string, Pos>, ids: string[]): { z: number; p: Pos } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const id of ids) {
    const p = pos[id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { z: 1, p: { x: 0, y: 0 } };
  const pad = 70;
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const z = Math.max(MIN_ZOOM, Math.min(1, (W - 2 * pad) / bw, (H - 2 * pad) / bh));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { z, p: { x: W / 2 - cx * z, y: H / 2 - cy * z } };
}

function getNeighborhood(nodeId: string, edges: Pick<MemoryEdge, "source" | "target">[], hops = 2): Set<string> {
  const visited = new Set([nodeId]);
  let frontier = new Set([nodeId]);
  for (let i = 0; i < hops; i++) {
    const next = new Set<string>();
    for (const e of edges) {
      if (frontier.has(e.source) && !visited.has(e.target)) next.add(e.target);
      if (frontier.has(e.target) && !visited.has(e.source)) next.add(e.source);
    }
    next.forEach((id) => visited.add(id));
    frontier = next;
    if (frontier.size === 0) break;
  }
  return visited;
}

// Exported for direct testing — a self-loop (source === target) must only
// add one to that node's degree.
// Treating source and target as two independent increments double-counts
// it, inflating both nodeRadius sizing and the "{deg} edges" caption for
// any node with a self-loop. A single-group (leaf-scope) graph read keeps
// self-loops on the wire: graphiti_client.py's dedup only drops a
// self-loop-after-merge inside its `len(group_ids) > 1` block, so a
// single-scope view (the routine case per route.ts's descendants query)
// never goes through that block at all.
export function computeDegrees(
  nodeIds: string[],
  edges: Pick<MemoryEdge, "source" | "target">[],
): Record<string, number> {
  const deg: Record<string, number> = {};
  for (const id of nodeIds) deg[id] = 0;
  for (const e of edges) {
    if (e.source === e.target) {
      if (deg[e.source] !== undefined) deg[e.source]++;
      continue;
    }
    if (deg[e.source] !== undefined) deg[e.source]++;
    if (deg[e.target] !== undefined) deg[e.target]++;
  }
  return deg;
}

// The set of nodes actually in play given the current focus — shared by the
// label-density gate (visibleNodeCount/labelDensityActive) and
// selectLabeledNodeIds's own thinning decision below, so the two cannot
// drift out of sync by each independently computing
// "focusSet ? nodes.filter(...) : nodes" with nothing keeping a future edit
// to one in sync with the other.
export function visibleNodes<T extends { uuid: string }>(nodes: T[], focusSet: Set<string> | null): T[] {
  return focusSet ? nodes.filter((n) => focusSet.has(n.uuid)) : nodes;
}

// Node radius scales with degree so hubs are visually heavier than leaves.
function nodeRadius(degree: number, selected: boolean): number {
  return (selected ? 10 : 6) + Math.min(degree, 10) * 1.1;
}

// Above this many nodes, unconditional text labels turn into an unreadable
// smear. Below it, every node keeps a label —
// same feel as the small seeded-demo scale this file was originally tuned
// for. This only ever thins *labels*; every node's circle still renders
// and is still clickable, so nothing about which entities are visible or
// reachable changes, only how many names are drawn at once.
const LABEL_DENSITY_THRESHOLD = 40;

// The full set of node ids that should render a text label, given the
// current focus/selection/search state. Pure and exported so it's testable
// on its own.
//
// Gates on the size of the set that will actually be rendered *after*
// focus-neighborhood expansion, not on whether a focus is active at all.
// getNeighborhood is an uncapped BFS against graphs fetched at limit=300,
// so on a hub-and-satellite graph (this file's own layout is tuned for
// that shape) a 2-hop neighborhood from the hub can be the entire graph —
// worse than the unfocused clutter this thinning exists to fix. A genuinely
// small focused neighborhood still renders every label, same as today.
export function selectLabeledNodeIds(
  nodes: Pick<MemoryNode, "uuid">[],
  edges: Pick<MemoryEdge, "source" | "target">[],
  focusSet: Set<string> | null,
  selectedUuid: string | null,
  matchSet: Set<string> | null,
): Set<string> {
  const visible = visibleNodes(nodes, focusSet);
  if (visible.length <= LABEL_DENSITY_THRESHOLD) {
    return new Set(visible.map((n) => n.uuid));
  }
  const degrees = computeDegrees(
    nodes.map((n) => n.uuid),
    edges,
  );
  const labeled = new Set(
    [...visible]
      .sort((a, b) => (degrees[b.uuid] ?? 0) - (degrees[a.uuid] ?? 0))
      .slice(0, LABEL_DENSITY_THRESHOLD)
      .map((n) => n.uuid),
  );
  if (selectedUuid) labeled.add(selectedUuid);
  matchSet?.forEach((id) => labeled.add(id));
  return labeled;
}

// Zoom-reveal (progressive disclosure past ZOOM_LABEL_REVEAL) still
// needs its own cap. "Zoomed in" does not imply "few nodes on screen" — a
// centred scroll on the densest node of a hub-and-satellite graph can put far
// more than LABEL_DENSITY_THRESHOLD nodes in the visible frame at once
// (measured ~70 on a 300-node graph at the exact ZOOM_LABEL_REVEAL crossing),
// which is exactly the clutter the label-density gate above exists to
// prevent. The fix is viewport culling, not a higher
// threshold — raising the threshold only moves the same overshoot to a later
// zoom level. Cap zoom-reveal to top-N by degree among nodes whose position
// actually falls inside the current pan+zoom frame, the same treatment item
// 47 gave the unfocused case above.
export function selectZoomRevealedNodeIds(
  nodes: Pick<MemoryNode, "uuid">[],
  pos: Record<string, Pos>,
  zoom: number,
  pan: Pos,
  degrees: Record<string, number>,
  focusSet: Set<string> | null,
): Set<string> {
  const inFrame = visibleNodes(nodes, focusSet).filter((n) => {
    const p = pos[n.uuid];
    if (!p) return false;
    const x = pan.x + p.x * zoom;
    const y = pan.y + p.y * zoom;
    return x >= 0 && x <= W && y >= 0 && y <= H;
  });
  if (inFrame.length <= LABEL_DENSITY_THRESHOLD) {
    return new Set(inFrame.map((n) => n.uuid));
  }
  return new Set(
    [...inFrame]
      .sort((a, b) => (degrees[b.uuid] ?? 0) - (degrees[a.uuid] ?? 0))
      .slice(0, LABEL_DENSITY_THRESHOLD)
      .map((n) => n.uuid),
  );
}

// Degree-aware spring-embedder.
//
// Three degree-driven forces produce the hub-and-satellite shape:
//   Repulsion  — hub↔hub pairs push apart much harder (proportional to degree product)
//                so hubs spread across the canvas instead of piling up.
//   Spring     — ideal length shrinks for high-degree connections (hub–hub pulls close,
//                hub–leaf stays longer, leaf–leaf stays longest) so edge lengths encode
//                relationship strength visually.
//   Gravity    — hubs are pulled toward canvas centre more strongly than leaves, keeping
//                the core dense while satellites orbit at natural distances.
function springLayout(
  nodeIds: string[],
  edges: Pick<MemoryEdge, "source" | "target">[],
  initial: Record<string, Pos>,
  degrees: Record<string, number>,
): Record<string, Pos> {
  if (nodeIds.length === 0) return initial;
  const pos: Record<string, Pos> = {};
  const vel: Record<string, Pos> = {};
  for (const id of nodeIds) {
    pos[id] = { ...(initial[id] ?? { x: W / 2, y: H / 2 }) };
    vel[id] = { x: 0, y: 0 };
  }

  const n = nodeIds.length;
  const REPULSION = 7000;
  const SPRING_K = 0.04;
  const IDEAL_BASE = 170;
  const DAMP = 0.78;
  // Gravity scales with node count: soft for small scopes (airy spacing) but
  // firm enough at ~80 nodes to keep peripheral nodes from drifting off-frame.
  const GRAVITY = 0.004 * (1 + Math.log10(Math.max(n, 1)));

  const ITERS = 180;
  // Fruchterman-Reingold cooling. Cap each node's per-step move to a
  // temperature that decays to ~0. Without this, hubs seeded near the centre
  // explode apart on the first few iterations (repulsion ∝ 1/d² blows up as
  // d→0), fling off-frame, and 180 iterations can't reel them back — which is
  // what collapsed the root scope into a line while small scopes stayed fine.
  const T0 = Math.max(W, H) / 8;

  for (let iter = 0; iter < ITERS; iter++) {
    const temp = T0 * (1 - iter / ITERS);
    const fx: Record<string, number> = {};
    const fy: Record<string, number> = {};
    for (const id of nodeIds) {
      fx[id] = 0;
      fy[id] = 0;
    }

    // Repulsion: uniform across all pairs
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const na = nodeIds[a],
          nb = nodeIds[b];
        let dx = pos[nb].x - pos[na].x;
        let dy = pos[nb].y - pos[na].y;
        let d2 = dx * dx + dy * dy;
        // Coincident nodes have no defined repulsion direction — nudge them
        // apart deterministically so they never stay stacked.
        if (d2 < 0.01) {
          dx = ((a * 7 + b) % 11) - 5;
          dy = ((a * 3 + b * 5) % 11) - 5;
          d2 = dx * dx + dy * dy || 1;
        }
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        fx[na] -= (f * dx) / d;
        fy[na] -= (f * dy) / d;
        fx[nb] += (f * dx) / d;
        fy[nb] += (f * dy) / d;
      }
    }

    // Spring: fixed ideal length for all edges
    for (const e of edges) {
      if (!pos[e.source] || !pos[e.target]) continue;
      const dx = pos[e.target].x - pos[e.source].x;
      const dy = pos[e.target].y - pos[e.source].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = SPRING_K * (d - IDEAL_BASE);
      fx[e.source] += (f * dx) / d;
      fy[e.source] += (f * dy) / d;
      fx[e.target] -= (f * dx) / d;
      fy[e.target] -= (f * dy) / d;
    }

    // Gravity: hubs pulled toward centre more strongly than leaves
    for (const id of nodeIds) {
      const deg = degrees[id] ?? 0;
      const g = GRAVITY * (1 + Math.log1p(deg) * 1.3);
      fx[id] += (W / 2 - pos[id].x) * g;
      fy[id] += (H / 2 - pos[id].y) * g;
    }

    // Integrate with damping, then clamp displacement to the temperature so
    // no node can jump further than `temp` in a single step.
    for (const id of nodeIds) {
      vel[id].x = (vel[id].x + fx[id]) * DAMP;
      vel[id].y = (vel[id].y + fy[id]) * DAMP;
      let mx = vel[id].x,
        my = vel[id].y;
      const speed = Math.sqrt(mx * mx + my * my);
      if (speed > temp && speed > 0) {
        mx = (mx / speed) * temp;
        my = (my / speed) * temp;
      }
      pos[id].x += mx;
      pos[id].y += my;
    }
  }
  return pos;
}

const ACTOR_COLOR: Record<string, string> = {
  human: "var(--color-gold)",
  agent: "var(--color-ember)",
  extraction: "color-mix(in srgb, var(--color-marble) 80%, transparent)",
};

// Shared control treatments: bordered pill buttons, field tokens, the eyebrow label.
const CONTROL =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-divider px-4 py-2 text-sm text-fg-muted transition-colors hover:border-accent/35 hover:bg-fg/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";
const FIELD =
  "border border-[var(--field-border)] bg-[var(--field-background)] text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";
const EYEBROW = "text-eyebrow font-semibold uppercase text-fg-subtle";
// Inline-block, not flex, so ::first-letter can sentence-case labels that used to be shown in capitals.
const TEXT_BUTTON =
  "inline-block min-h-9 rounded-lg px-2 text-sm leading-9 text-fg-subtle transition-colors first-letter:uppercase hover:text-fg disabled:opacity-40";

function edgeColor(e: MemoryEdge): string {
  return e.actorType ? (ACTOR_COLOR[e.actorType] ?? ACTOR_COLOR.extraction) : ACTOR_COLOR.extraction;
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

export function GraphExplorer({
  scope,
  canDelete,
  canWrite,
}: {
  scope?: string | null;
  canDelete?: boolean;
  canWrite?: boolean;
}) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [pos, setPos] = useState<Record<string, Pos>>({});
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<MemoryEdge | null>(null);
  // The last finished entity lookup, tagged with the selection (node object +
  // scope) it answered. Detail and loading are derived from it, so a new
  // selection reads as loading -- and no selection as empty -- without a
  // setState in the fetch effect.
  const [entityFetch, setEntityFetch] = useState<{
    node: MemoryNode;
    scope: string | null | undefined;
    detail: MemoryEntity | null;
  } | null>(null);
  const entityAnswered = !!selectedNode && entityFetch?.node === selectedNode && entityFetch.scope === scope;
  const entityDetail = entityAnswered ? entityFetch.detail : null;
  const entityLoading = !!selectedNode && !entityAnswered;
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingEdge, setRemovingEdge] = useState<string | null>(null);
  const [removingNode, setRemovingNode] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeStatus, setMergeStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [factsPage, setFactsPage] = useState(10);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // Refs kept in sync with state so event handlers always see current values
  // without stale closures.
  const zoomRef = useRef(1);
  const panRef = useRef<Pos>({ x: 0, y: 0 });

  const setZoomPan = useCallback((z: number, p: Pos) => {
    zoomRef.current = z;
    panRef.current = p;
    setZoom(z);
    setPan(p);
  }, []);

  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panStart = useRef<{ vx: number; vy: number; ox: number; oy: number } | null>(null);
  const didPan = useRef(false);
  const justSelectedEdge = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The initial render (loading=true) has no <svg> in the tree yet, so a
  // plain useRef never tells the wheel-zoom effect below that the real node
  // showed up later. This callback ref flips svgMounted once it actually
  // attaches, giving that effect something to depend on and re-run against.
  const [svgMounted, setSvgMounted] = useState(false);
  const attachSvgRef = useCallback((node: SVGSVGElement | null) => {
    svgRef.current = node;
    setSvgMounted(node !== null);
  }, []);

  // Client coords → SVG viewport coords (0–W × 0–H)
  const toSvgVP = useCallback((clientX: number, clientY: number): Pos => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H,
    };
  }, []);

  // Client coords → world coords (inverse of pan+zoom transform)
  const toWorld = useCallback(
    (clientX: number, clientY: number): Pos => {
      const vp = toSvgVP(clientX, clientY);
      return {
        x: (vp.x - panRef.current.x) / zoomRef.current,
        y: (vp.y - panRef.current.y) / zoomRef.current,
      };
    },
    [toSvgVP],
  );

  // Wheel zoom registered directly so we can call preventDefault (passive:false)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const z = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
      const vp = toSvgVP(e.clientX, e.clientY);
      const p = panRef.current;
      setZoomPan(newZ, {
        x: vp.x - (vp.x - p.x) * (newZ / z),
        y: vp.y - (vp.y - p.y) * (newZ / z),
      });
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [svgMounted, toSvgVP, setZoomPan]);

  const fetchGraph = useCallback(
    async (query?: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = query ? `&query=${encodeURIComponent(query)}` : "";
        const scopeQs = scope ? `&scope=${encodeURIComponent(scope)}` : "";
        const res = await fetch(`/api/memory/graph?limit=300${qs}${scopeQs}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "failed to load graph");
        const g = body as MemoryGraph;
        setGraph(g);
        const nodeIds = g.nodes.map((nd) => nd.uuid);
        const degrees = computeDegrees(nodeIds, g.edges);
        // Seed hubs near centre, leaves at the rim — gives the spring a good start
        // so it converges to the hub-and-satellite shape faster.
        const sorted = [...nodeIds].sort((a, b) => (degrees[b] ?? 0) - (degrees[a] ?? 0));
        const outerR = Math.min(W, H) / 2 + 40; // wider than the frame so leaves start outside
        const GOLDEN = Math.PI * (3 - Math.sqrt(5));
        const ring: Record<string, Pos> = {};
        sorted.forEach((id, i) => {
          const ratio = i / Math.max(sorted.length, 1);
          const angle = i * GOLDEN;
          // Min radius keeps the highest-degree hubs off the exact centre so they
          // don't start stacked on top of each other (which the spring can't undo).
          const radius = (0.18 + 0.82 * ratio) * outerR;
          ring[id] = {
            x: W / 2 + Math.cos(angle) * radius,
            y: H / 2 + Math.sin(angle) * radius,
          };
        });
        const laid = springLayout(nodeIds, g.edges, ring, degrees);
        setPos(laid);
        setSelectedNode(null);
        setSelectedEdge(null);
        const fit = fitView(laid, nodeIds);
        setZoomPan(fit.z, fit.p);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to load graph");
      } finally {
        setLoading(false);
      }
    },
    [scope, setZoomPan],
  );

  useEffect(() => {
    void (async () => {
      await fetchGraph();
    })();
  }, [fetchGraph]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchGraph();
    setRefreshing(false);
  }, [fetchGraph]);

  useEffect(() => {
    if (!selectedNode) return;
    const node = selectedNode;
    // Set when the selection (or scope) moves on: a slow answer for an earlier
    // node must not overwrite the current node's entry.
    let stale = false;
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    fetch(`/api/memory/entities/${encodeURIComponent(node.uuid)}${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!stale) setEntityFetch({ node, scope, detail: data ?? null });
      })
      .catch(() => {
        if (!stale) setEntityFetch({ node, scope, detail: null });
      });
    return () => {
      stale = true;
    };
  }, [selectedNode, scope]);

  async function removeNode(uuid: string) {
    if (removingNode) return;
    setRemovingNode(uuid);
    try {
      const res = await fetch(`/api/memory/entities/${encodeURIComponent(uuid)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) return;
      setGraph((g) =>
        g
          ? {
              ...g,
              nodes: g.nodes.filter((n) => n.uuid !== uuid),
              edges: g.edges.filter((e) => e.source !== uuid && e.target !== uuid),
            }
          : g,
      );
      setSelectedNode(null);
    } finally {
      setRemovingNode(null);
    }
  }

  async function removeEdge(uuid: string) {
    if (removingEdge) return;
    setRemovingEdge(uuid);
    try {
      await fetch(`/api/memory/facts/${encodeURIComponent(uuid)}`, { method: "DELETE" });
      // Remove from graph state immediately, deselect if it was selected.
      setGraph((g) => (g ? { ...g, edges: g.edges.filter((e) => e.uuid !== uuid) } : g));
      if (selectedEdge?.uuid === uuid) setSelectedEdge(null);
    } finally {
      setRemovingEdge(null);
    }
  }

  async function mergeEntity() {
    if (!selectedNode || !mergeTarget.trim() || mergeStatus === "loading") return;
    setMergeStatus("loading");
    try {
      const res = await fetch("/api/memory/entities/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromName: selectedNode.name, toName: mergeTarget.trim(), scope: scope ?? undefined }),
      });
      if (!res.ok) {
        setMergeStatus("error");
        return;
      }
      setMergeStatus("done");
      setMerging(false);
      setMergeTarget("");
      // Remove the old node from the graph and refresh
      setGraph((g) =>
        g
          ? {
              nodes: g.nodes.filter((n) => n.uuid !== selectedNode.uuid),
              edges: g.edges.filter((e) => e.source !== selectedNode.uuid && e.target !== selectedNode.uuid),
            }
          : g,
      );
      setSelectedNode(null);
      // Full refresh to show the transferred edges on the target node
      setTimeout(() => void fetchGraph(), 800);
    } catch {
      setMergeStatus("error");
    }
  }

  // ── pointer handlers ──────────────────────────────────────────────────────

  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (drag.current) return; // node drag takes priority
      e.currentTarget.setPointerCapture(e.pointerId);
      const vp = toSvgVP(e.clientX, e.clientY);
      panStart.current = { vx: vp.x, vy: vp.y, ox: panRef.current.x, oy: panRef.current.y };
      didPan.current = false;
      setIsPanning(true);
    },
    [toSvgVP],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (drag.current) {
        const world = toWorld(e.clientX, e.clientY);
        const { id, dx, dy } = drag.current;
        setPos((prev) => ({ ...prev, [id]: { x: world.x - dx, y: world.y - dy } }));
      } else if (panStart.current) {
        const vp = toSvgVP(e.clientX, e.clientY);
        const newPan = {
          x: panStart.current.ox + vp.x - panStart.current.vx,
          y: panStart.current.oy + vp.y - panStart.current.vy,
        };
        if (Math.abs(newPan.x - panStart.current.ox) > 2 || Math.abs(newPan.y - panStart.current.oy) > 2) {
          didPan.current = true;
        }
        panRef.current = newPan;
        setPan(newPan);
      }
    },
    [toSvgVP, toWorld],
  );

  const endInteraction = useCallback(() => {
    drag.current = null;
    panStart.current = null;
    setIsPanning(false);
  }, []);

  const onSvgClick = useCallback(() => {
    if (didPan.current) {
      didPan.current = false;
      return;
    }
    if (justSelectedEdge.current) {
      justSelectedEdge.current = false;
      return;
    }
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const z = zoomRef.current;
      const newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
      const p = panRef.current;
      setZoomPan(newZ, {
        x: W / 2 - (W / 2 - p.x) * (newZ / z),
        y: H / 2 - (H / 2 - p.y) * (newZ / z),
      });
    },
    [setZoomPan],
  );

  const resetView = useCallback(() => setZoomPan(1, { x: 0, y: 0 }), [setZoomPan]);

  // ── derived ───────────────────────────────────────────────────────────────

  const searchLower = search.toLowerCase().trim();
  const matchSet = useMemo<Set<string> | null>(
    () =>
      searchLower
        ? new Set(graph?.nodes.filter((n) => n.name.toLowerCase().includes(searchLower)).map((n) => n.uuid) ?? [])
        : null,
    [searchLower, graph],
  );

  // When a node is selected, only render nodes within 2 hops of it.
  // null means no filter (show everything).
  const focusSet = useMemo<Set<string> | null>(() => {
    if (!selectedNode || !graph) return null;
    return getNeighborhood(selectedNode.uuid, graph.edges, 2);
  }, [selectedNode, graph]);

  // Degree per node, computed once per graph rather than re-filtering all
  // edges for every node on every render (the O(n·e) cost that made the
  // render loop itself part of the readability problem at real scale).
  const nodeDegrees = useMemo(
    () =>
      graph
        ? computeDegrees(
            graph.nodes.map((n) => n.uuid),
            graph.edges,
          )
        : {},
    [graph],
  );

  // Thinning gates on how many nodes will actually render right now — the
  // focused (2-hop) neighborhood when one's active, the whole graph
  // otherwise — not on whether a focus merely exists. See
  // selectLabeledNodeIds above for why: an uncapped BFS focus can be as
  // large as the full graph.
  const visibleNodeCount = graph ? visibleNodes(graph.nodes, focusSet).length : 0;
  const labelDensityActive = visibleNodeCount > LABEL_DENSITY_THRESHOLD;
  const labeledNodeIds = useMemo<Set<string> | null>(
    () =>
      graph ? selectLabeledNodeIds(graph.nodes, graph.edges, focusSet, selectedNode?.uuid ?? null, matchSet) : null,
    [graph, focusSet, selectedNode, matchSet],
  );

  // Progressive disclosure on top of the thinning gate above: a name that
  // static thinning hid still comes back on hover or on zooming in, so
  // nothing is permanently hidden, only hidden by default. Select-reveal
  // needs no extra state here — selectLabeledNodeIds already always labels
  // selectedNode/matchSet, so showLabel below picks that up for free.
  const zoomRevealed = zoom >= ZOOM_LABEL_REVEAL;
  // Only actually needed once zoomed past the reveal threshold — see
  // selectZoomRevealedNodeIds above for why zoom alone can't be trusted to
  // keep the in-frame set small.
  const zoomRevealedNodeIds = useMemo<Set<string> | null>(
    () =>
      graph && zoomRevealed ? selectZoomRevealedNodeIds(graph.nodes, pos, zoom, pan, nodeDegrees, focusSet) : null,
    [graph, zoomRevealed, pos, zoom, pan, nodeDegrees, focusSet],
  );

  if (loading) {
    return <div className="grid h-[540px] place-items-center text-sm text-fg-muted">Loading graph…</div>;
  }
  if (error) {
    return (
      <div className="grid h-[540px] place-items-center px-6 text-center">
        <div>
          <p className="text-base font-semibold text-danger">Couldn&apos;t load the graph.</p>
          <p className="mt-1 break-all font-mono text-xs text-fg-subtle">{error}</p>
        </div>
      </div>
    );
  }
  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="grid h-[540px] place-items-center px-6 text-center">
        <div>
          <p className="text-lg font-semibold text-fg">No memory to map yet.</p>
          <p className="mt-1 text-sm text-fg-muted">Ingest facts and the graph fills in.</p>
        </div>
      </div>
    );
  }

  const zoomPct = Math.round(zoom * 100);

  return (
    <div className="flex flex-col gap-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && searchLower) void fetchGraph(searchLower);
          }}
          placeholder="Search entities…"
          className={`min-h-10 min-w-0 basis-full flex-1 rounded-full px-4 py-2 text-sm ${FIELD} sm:basis-0`}
        />
        {searchLower && (
          <button onClick={() => void fetchGraph(searchLower)} className={CONTROL}>
            Focus
          </button>
        )}
        {/* zoom controls */}
        <div className="flex items-center gap-1 rounded-full border border-divider bg-fg/[0.03] p-1">
          <button
            onClick={() => zoomBy(1.25)}
            title="Zoom in"
            className="flex h-8 w-8 items-center justify-center rounded-full text-base text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg"
          >
            +
          </button>
          <span className="min-w-[3rem] select-none text-center font-mono text-xs tabular-nums text-fg-subtle">
            {zoomPct}%
          </span>
          <button
            onClick={() => zoomBy(1 / 1.25)}
            title="Zoom out"
            className="flex h-8 w-8 items-center justify-center rounded-full text-base text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg"
          >
            −
          </button>
        </div>
        <button
          onClick={() => {
            setSearch("");
            resetView();
          }}
          className={CONTROL}
          title="Reset view"
        >
          ↺
        </button>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className={CONTROL}
          title="Refresh graph data"
        >
          {refreshing ? "…" : "Refresh"}
        </button>
      </div>

      {/* graph canvas */}
      <svg
        ref={attachSvgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`h-[540px] w-full touch-none select-none rounded-2xl border border-divider bg-ink/60 ${isPanning ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endInteraction}
        onPointerLeave={endInteraction}
        onClick={onSvgClick}
      >
        {/* invisible backdrop to absorb deselect clicks */}
        <rect x={0} y={0} width={W} height={H} fill="transparent" />

        {/* hint — outside the transform group so it stays fixed */}
        <text
          x={W - 12}
          y={H - 10}
          textAnchor="end"
          fontSize={12}
          fill="var(--color-fg-subtle)"
          className="pointer-events-none select-none font-sans"
        >
          scroll to zoom · drag canvas to pan · drag nodes
        </text>

        {/* ── all graph content inside pan+zoom transform ── */}
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {/* ── edges ─────────────────────────────────────────────────── */}
          {graph.edges.map((e) => {
            const a = pos[e.source];
            const b = pos[e.target];
            if (!a || !b) return null;
            if (focusSet && (!focusSet.has(e.source) || !focusSet.has(e.target))) return null;

            const isSelEdge = e.uuid === selectedEdge?.uuid;
            const isHot =
              isSelEdge ||
              hoveredEdge === e.uuid ||
              !!(selectedNode && (e.source === selectedNode.uuid || e.target === selectedNode.uuid));
            const isDim = !!(matchSet && !matchSet.has(e.source) && !matchSet.has(e.target));
            const color = edgeColor(e);
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;

            const provenanceLine = [
              (e.actorName ? displayWriterLabel(e.actorName) : null) ??
                (e.actorType && e.actorType !== "extraction" ? e.actorType : null),
              fmtDate(e.validAt),
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <g key={e.uuid}>
                {/* fat invisible hit zone */}
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="transparent"
                  strokeWidth={14}
                  className="cursor-pointer"
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    justSelectedEdge.current = true;
                    setSelectedEdge(e);
                    setSelectedNode(null);
                  }}
                  onClick={(ev) => ev.stopPropagation()}
                  onPointerEnter={() => setHoveredEdge(e.uuid)}
                  onPointerLeave={() => setHoveredEdge(null)}
                />
                {/* selected glow layer */}
                {isSelEdge && (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={color}
                    strokeOpacity={0.25}
                    strokeWidth={8}
                    pointerEvents="none"
                  />
                )}
                {/* visible line */}
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={isHot ? color : "var(--color-marble)"}
                  strokeOpacity={isDim ? 0.04 : isSelEdge ? 1 : isHot ? 0.85 : 0.18}
                  strokeWidth={isSelEdge ? 2.5 : isHot ? 2 : 1}
                  strokeDasharray={isHot ? undefined : "4 3"}
                  pointerEvents="none"
                />
                {/* midpoint dot affordance */}
                {!isHot && !isDim && (
                  <circle cx={mx} cy={my} r={2.5} fill="var(--color-marble)" fillOpacity={0.14} pointerEvents="none" />
                )}
                {/* inline labels on hot edges: fact + provenance */}
                {isHot && (
                  // A halo in the canvas colour keeps the label legible over lines in both themes.
                  <g
                    pointerEvents="none"
                    stroke="var(--color-ink)"
                    strokeWidth={4}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                  >
                    <text
                      x={mx}
                      y={my - (provenanceLine ? 12 : 8)}
                      textAnchor="middle"
                      fontSize={12}
                      fill="var(--color-fg)"
                      className="select-none font-sans"
                    >
                      {e.fact.length > 56 ? e.fact.slice(0, 53) + "…" : e.fact}
                    </text>
                    {provenanceLine && (
                      <text
                        x={mx}
                        y={my + 2}
                        textAnchor="middle"
                        fontSize={12}
                        fill="var(--color-fg-muted)"
                        className="select-none font-sans"
                      >
                        {provenanceLine}
                      </text>
                    )}
                  </g>
                )}
              </g>
            );
          })}

          {/* ── nodes ─────────────────────────────────────────────────── */}
          {graph.nodes.map((n) => {
            const p = pos[n.uuid];
            if (!p) return null;
            if (focusSet && !focusSet.has(n.uuid)) return null;
            const isSel = n.uuid === selectedNode?.uuid;
            const isDim = !!(matchSet && !matchSet.has(n.uuid));
            const isMatch = !!matchSet?.has(n.uuid);
            const deg = nodeDegrees[n.uuid] ?? 0;
            const r = nodeRadius(deg, isSel);
            const labelX = r + 6;
            const isHovered = hoveredNode === n.uuid;
            const showLabel =
              isHovered ||
              (labeledNodeIds?.has(n.uuid) ?? true) ||
              (zoomRevealed && (zoomRevealedNodeIds?.has(n.uuid) ?? false));

            return (
              <g
                key={n.uuid}
                transform={`translate(${p.x} ${p.y})`}
                className="cursor-grab active:cursor-grabbing"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const world = toWorld(e.clientX, e.clientY);
                  drag.current = { id: n.uuid, dx: world.x - p.x, dy: world.y - p.y };
                  setSelectedNode(n);
                  setSelectedEdge(null);
                  setFactsPage(10);
                  didPan.current = false;
                }}
                onPointerEnter={() => setHoveredNode(n.uuid)}
                onPointerLeave={() => setHoveredNode((cur) => (cur === n.uuid ? null : cur))}
              >
                {(isSel || isMatch) && (
                  <circle
                    r={r + (isSel ? 7 : 5)}
                    fill="none"
                    stroke={isSel ? "var(--color-gold)" : "var(--color-ember)"}
                    strokeOpacity={0.25}
                    strokeWidth={isSel ? 8 : 5}
                  />
                )}
                <circle
                  r={r}
                  fill={isDim ? "var(--color-ink)" : isSel ? "var(--color-gold)" : "var(--color-gunpowder)"}
                  stroke={
                    isSel
                      ? "var(--color-gold)"
                      : isMatch
                        ? "var(--color-ember)"
                        : "color-mix(in srgb, var(--color-gold) 65%, transparent)"
                  }
                  strokeOpacity={isDim ? 0.15 : 1}
                  strokeWidth={isSel ? 2 : 1.5}
                />
                {showLabel && (
                  <text
                    x={labelX}
                    y={4}
                    fontSize={isSel ? 14 : 12}
                    fontWeight={isSel || isMatch ? 600 : 400}
                    fill={isDim ? "var(--color-fg-subtle)" : "var(--color-fg)"}
                    pointerEvents="none"
                    className="select-none font-sans"
                  >
                    {n.name}
                  </text>
                )}
                {isSel && (
                  <text
                    x={labelX}
                    y={18}
                    fontSize={12}
                    fill="var(--color-fg-subtle)"
                    pointerEvents="none"
                    className="select-none font-sans"
                  >
                    {n.type} · {deg} edge{deg !== 1 ? "s" : ""}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* ── detail panel ──────────────────────────────────────────── */}
      {(selectedNode || selectedEdge) && (
        <div className="glass-surface rounded-2xl px-5 py-5 sm:px-6">
          {selectedNode && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className={EYEBROW}>{selectedNode.type}</p>
                  <p className="mt-1 break-words text-lg font-semibold text-fg">{selectedNode.name}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canWrite && (
                    <button
                      onClick={() => {
                        setMerging((v) => !v);
                        setMergeTarget("");
                        setMergeStatus("idle");
                      }}
                      className={TEXT_BUTTON}
                    >
                      merge into
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => void removeNode(selectedNode.uuid)}
                      disabled={removingNode === selectedNode.uuid}
                      className={`${TEXT_BUTTON} hover:text-danger`}
                    >
                      {removingNode === selectedNode.uuid ? "deleting…" : "delete"}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setSelectedNode(null);
                      setMerging(false);
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-fg/5 hover:text-fg"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {merging && (
                <div className="flex flex-col gap-3 border-t border-divider pt-4">
                  <p className="text-sm text-fg-muted">
                    Merge <span className="font-semibold text-fg">{selectedNode.name}</span> into
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={mergeTarget}
                      onChange={(e) => {
                        setMergeTarget(e.target.value);
                        setMergeStatus("idle");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void mergeEntity();
                        if (e.key === "Escape") setMerging(false);
                      }}
                      placeholder="canonical entity name…"
                      className={`min-h-10 min-w-0 flex-1 rounded-xl px-3 py-2 text-sm ${FIELD}`}
                    />
                    <button
                      onClick={() => void mergeEntity()}
                      disabled={!mergeTarget.trim() || mergeStatus === "loading"}
                      className="min-h-10 shrink-0 rounded-xl bg-action px-4 text-sm font-semibold text-action-foreground transition-opacity first-letter:uppercase hover:opacity-90 disabled:opacity-40"
                    >
                      {mergeStatus === "loading" ? "merging…" : "merge"}
                    </button>
                  </div>
                  {mergeStatus === "error" && (
                    <p className="text-sm text-danger">Merge failed — check entity name and try again.</p>
                  )}
                  <p className="text-sm text-fg-subtle">
                    All edges from this node transfer to the target. This node is deleted.
                  </p>
                </div>
              )}

              {entityLoading && <p className="text-sm text-fg-muted">Loading…</p>}

              {!entityLoading && (
                <>
                  {entityDetail?.summary && (
                    <p className="text-sm leading-relaxed text-fg-muted">{entityDetail.summary}</p>
                  )}

                  {(() => {
                    const PAGE = 10;
                    const allConnected = (graph?.edges ?? [])
                      .filter((e) => e.source === selectedNode.uuid || e.target === selectedNode.uuid)
                      // Most recent first; superseded last
                      .sort((a, b) => {
                        const aSuperseded = !!(a.invalidAt && a.invalidAt !== a.validAt);
                        const bSuperseded = !!(b.invalidAt && b.invalidAt !== b.validAt);
                        if (aSuperseded !== bSuperseded) return aSuperseded ? 1 : -1;
                        return (b.validAt ?? "").localeCompare(a.validAt ?? "");
                      });
                    const connected = allConnected.slice(0, factsPage);
                    if (allConnected.length === 0)
                      return <p className="text-sm text-fg-subtle">No relationships in this graph.</p>;
                    const nodeMap = Object.fromEntries((graph?.nodes ?? []).map((n) => [n.uuid, n]));
                    return (
                      <div className="flex flex-col gap-2">
                        <p className={EYEBROW}>
                          Relationships ({allConnected.length}
                          {factsPage < allConnected.length ? `, showing ${factsPage}` : ""})
                        </p>
                        <ul className="flex flex-col divide-y divide-divider">
                          {connected.map((e) => {
                            const isOut = e.source === selectedNode.uuid;
                            const otherId = isOut ? e.target : e.source;
                            const other = nodeMap[otherId];
                            const color = edgeColor(e);
                            return (
                              <li key={e.uuid} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                                {/* Other entity + direction */}
                                <div className="flex flex-wrap items-center gap-1.5 text-sm text-fg-subtle">
                                  <span>{isOut ? "→" : "←"}</span>
                                  <span className="break-words font-semibold text-fg">{other?.name ?? otherId}</span>
                                  {other?.type && (
                                    <span className="rounded-full border border-divider px-2 py-0.5 text-sm text-fg-subtle">
                                      {other.type}
                                    </span>
                                  )}
                                </div>
                                {/* Fact text */}
                                <p className="break-words text-sm leading-relaxed text-fg-muted">{e.fact}</p>
                                {/* Provenance + remove */}
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-subtle">
                                  {e.actorName && (
                                    <span className="flex items-center gap-1.5 text-fg-muted">
                                      <span
                                        aria-hidden="true"
                                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                                        style={{ background: color }}
                                      />
                                      {displayWriterLabel(e.actorName)}
                                    </span>
                                  )}
                                  {e.validAt && <span>{fmtDate(e.validAt)}</span>}
                                  {e.invalidAt && e.invalidAt !== e.validAt && (
                                    <span className="text-warning">superseded</span>
                                  )}
                                  {canDelete && (
                                    <button
                                      onClick={() => void removeEdge(e.uuid)}
                                      disabled={removingEdge === e.uuid}
                                      className={`${TEXT_BUTTON} ml-auto hover:text-danger`}
                                    >
                                      {removingEdge === e.uuid ? "removing…" : "remove"}
                                    </button>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        {factsPage < allConnected.length && (
                          <button
                            onClick={() => setFactsPage((p) => p + PAGE)}
                            className="mt-1 inline-block min-h-9 self-start text-left text-sm font-semibold leading-9 text-fg-muted transition-colors first-letter:uppercase hover:text-fg"
                          >
                            show {Math.min(PAGE, allConnected.length - factsPage)} more
                            <span className="ml-1 font-normal text-fg-subtle">
                              ({allConnected.length - factsPage} remaining)
                            </span>
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {selectedEdge &&
            (() => {
              const nodeMap = Object.fromEntries((graph?.nodes ?? []).map((n) => [n.uuid, n]));
              const src = nodeMap[selectedEdge.source];
              const tgt = nodeMap[selectedEdge.target];
              const color = edgeColor(selectedEdge);
              return (
                <div className="flex flex-col gap-4">
                  {/* Connection header */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-base">
                      <span className="break-words font-semibold text-fg">{src?.name ?? selectedEdge.source}</span>
                      <span className="text-fg-subtle">→</span>
                      <span className="break-words font-semibold text-fg">{tgt?.name ?? selectedEdge.target}</span>
                    </div>
                    <button
                      onClick={() => setSelectedEdge(null)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-fg/5 hover:text-fg"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Fact */}
                  <div>
                    <p className={`mb-1 ${EYEBROW}`}>Fact</p>
                    <p className="break-words text-sm leading-relaxed text-fg">{selectedEdge.fact}</p>
                  </div>

                  {/* Metadata row */}
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    <div>
                      <p className={`mb-1 ${EYEBROW}`}>Created by</p>
                      {selectedEdge.actorType ? (
                        <span className="flex items-center gap-1.5 text-sm text-fg-muted">
                          <span
                            aria-hidden="true"
                            className="inline-block h-2 w-2 shrink-0 rounded-full"
                            style={{ background: color }}
                          />
                          {selectedEdge.actorName
                            ? `${displayWriterLabel(selectedEdge.actorName)} · ${selectedEdge.actorType}`
                            : selectedEdge.actorType}
                        </span>
                      ) : (
                        <span className="text-sm text-fg-subtle">unknown</span>
                      )}
                    </div>

                    {selectedEdge.validAt && (
                      <div>
                        <p className={`mb-1 ${EYEBROW}`}>Recorded</p>
                        <p className="text-sm text-fg-muted">{fmtDate(selectedEdge.validAt)}</p>
                      </div>
                    )}

                    {selectedEdge.invalidAt && selectedEdge.invalidAt !== selectedEdge.validAt ? (
                      <div>
                        <p className={`mb-1 ${EYEBROW}`}>Status</p>
                        <p className="text-sm text-warning">Superseded — a newer fact replaced this</p>
                      </div>
                    ) : (
                      <div>
                        <p className={`mb-1 ${EYEBROW}`}>Status</p>
                        <span className="flex items-center gap-1.5 text-sm text-fg-muted">
                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
                          active
                        </span>
                      </div>
                    )}
                  </div>

                  {canDelete && (
                    <div className="mt-1 flex justify-end">
                      <button
                        onClick={() => void removeEdge(selectedEdge.uuid)}
                        disabled={removingEdge === selectedEdge.uuid}
                        className={`${TEXT_BUTTON} hover:text-danger`}
                      >
                        {removingEdge === selectedEdge.uuid ? "removing…" : "remove fact"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}
        </div>
      )}

      {/* ── legend ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-fg-subtle">
        <span>
          {graph.nodes.length} entities · {graph.edges.length} facts
          {labelDensityActive && (
            <span
              className="ml-2"
              title="Past this many entities, only the most-connected names stay labeled so the graph doesn't turn into text soup. Hover, select, search, or zoom in to see a hidden name."
            >
              · labels shown for the top {LABEL_DENSITY_THRESHOLD} most-connected — hover or zoom in for more
            </span>
          )}
        </span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {(["human", "agent", "extraction"] as const).map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ background: ACTOR_COLOR[t], opacity: 0.6 }}
              />
              <span className="first-letter:uppercase">{t === "extraction" ? "extracted" : t}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
