import { describe, expect, it } from "vitest";

// Standing regression test for graph-explorer's label-density thinning. This
// file gets re-tuned regularly as the layout algorithm changes (the
// Fruchterman-Reingold clamp, degree-weighted gravity, label thinning), and
// without a test each change would otherwise be verified by a throwaway
// bundle-and-drive run that leaves nothing behind to go red on the next edit.
//
// The component itself can't be rendered here (vitest's environment is
// node, there's no testing-library, and the graph arrives via fetch in an
// effect so a server render never produces nodes). The thinning decision
// is therefore exported as a pure selector and tested directly.
import { computeDegrees, selectLabeledNodeIds, selectZoomRevealedNodeIds, visibleNodes } from "./graph-explorer";

const THRESHOLD = 40;

type Node = { uuid: string };
type Edge = { source: string; target: string };

// Independent degree count. Deliberately NOT the component's computeDegrees
// (which isn't exported, and reusing it would make the ordering assertions
// tautological) — this is a second, hand-written source of truth.
function degreeOf(edges: Edge[], uuid: string): number {
  let d = 0;
  for (const e of edges) {
    if (e.source === uuid) d++;
    if (e.target === uuid) d++;
  }
  return d;
}

// The shape this file's own layout comments say the graph takes, and the
// shape that breaks a naive BFS cap: one hub wired to every satellite. A 2-hop
// neighborhood from the hub is the entire graph, because a 1-hop
// neighborhood already is.
function hubAndSatellites(total: number): { nodes: Node[]; edges: Edge[] } {
  const nodes = Array.from({ length: total }, (_, i) => ({ uuid: `n${i}` }));
  const edges = Array.from({ length: total - 1 }, (_, i) => ({
    source: "n0",
    target: `n${i + 1}`,
  }));
  return { nodes, edges };
}

// Tiered hubs: hub i owns (i+1) satellites, so degrees genuinely vary and
// "top N by degree" is a meaningful ordering rather than an arbitrary slice
// of an all-equal set.
function tieredHubs(hubCount: number): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (let h = 0; h < hubCount; h++) {
    const hub = `h${h}`;
    nodes.push({ uuid: hub });
    for (let s = 0; s <= h; s++) {
      const leaf = `h${h}s${s}`;
      nodes.push({ uuid: leaf });
      edges.push({ source: hub, target: leaf });
    }
  }
  return { nodes, edges };
}

describe("selectLabeledNodeIds", () => {
  describe("the round-1 regression: an uncapped focus neighborhood", () => {
    // The bug: thinning was gated on `!focusSet` — on whether a focus
    // existed at all — on the premise that a 2-hop view is inherently a
    // small subset. That premise is false. getNeighborhood is an uncapped
    // BFS and the graph is fetched at limit=300, so clicking the hub (the
    // biggest, most obvious target on screen) expanded the focus to the
    // whole graph AND switched thinning off, rendering 300 labels — worse
    // than the unfocused clutter the feature exists to fix.
    it("caps labels when a hub click expands focus to the entire graph", () => {
      const { nodes, edges } = hubAndSatellites(300);
      // 1-hop from the hub is already every node, so this set is the real
      // focus neighborhood by construction, not an assumption about BFS.
      const focusSet = new Set(nodes.map((n) => n.uuid));
      expect(focusSet.size).toBe(300);

      const labeled = selectLabeledNodeIds(nodes, edges, focusSet, "n0", null);

      expect(labeled.size).toBe(THRESHOLD);
      // The specific number that made this worse than shipping nothing.
      expect(labeled.size).toBeLessThan(nodes.length);
    });

    it("caps labels for a mid-tier neighborhood that is over the threshold", () => {
      const { nodes, edges } = hubAndSatellites(300);
      const focusSet = new Set(["n0", ...Array.from({ length: 64 }, (_, i) => `n${i + 1}`)]);
      expect(focusSet.size).toBeGreaterThan(THRESHOLD);

      expect(selectLabeledNodeIds(nodes, edges, focusSet, "n1", null).size).toBe(THRESHOLD);
    });

    it("still labels every node in a genuinely small focused neighborhood", () => {
      const { nodes, edges } = hubAndSatellites(300);
      const focusSet = new Set(["n0", "n1", "n2", "n3"]);

      const labeled = selectLabeledNodeIds(nodes, edges, focusSet, "n1", null);

      expect(labeled.size).toBe(4);
      expect([...focusSet].every((id) => labeled.has(id))).toBe(true);
    });
  });

  describe("unfocused thinning", () => {
    it("labels every node at and below the threshold", () => {
      for (const total of [1, 20, THRESHOLD]) {
        const { nodes, edges } = hubAndSatellites(total);
        const labeled = selectLabeledNodeIds(nodes, edges, null, null, null);
        expect(labeled.size).toBe(total);
      }
    });

    it("thins as soon as the graph is one node over the threshold", () => {
      const { nodes, edges } = hubAndSatellites(THRESHOLD + 1);
      expect(selectLabeledNodeIds(nodes, edges, null, null, null).size).toBe(THRESHOLD);
    });

    it("keeps the most-connected nodes and drops the least-connected", () => {
      // 12 tiered hubs -> 90 nodes, degrees ranging 1..12.
      const { nodes, edges } = tieredHubs(12);
      expect(nodes.length).toBeGreaterThan(THRESHOLD);

      const labeled = selectLabeledNodeIds(nodes, edges, null, null, null);
      expect(labeled.size).toBe(THRESHOLD);

      // The real invariant, stated so it survives ties: nothing that was
      // dropped may be better-connected than something that was kept.
      const kept = nodes.filter((n) => labeled.has(n.uuid)).map((n) => degreeOf(edges, n.uuid));
      const dropped = nodes.filter((n) => !labeled.has(n.uuid)).map((n) => degreeOf(edges, n.uuid));
      expect(Math.min(...kept)).toBeGreaterThanOrEqual(Math.max(...dropped));

      // And the biggest hub is never the thing that gets dropped.
      expect(labeled.has("h11")).toBe(true);
    });
  });

  describe("selection and search always survive thinning", () => {
    it("labels the selected node even when it is too small to make the cut", () => {
      const { nodes, edges } = hubAndSatellites(300);
      const leaf = "n299";
      expect(degreeOf(edges, leaf)).toBe(1);

      const labeled = selectLabeledNodeIds(nodes, edges, null, leaf, null);

      expect(labeled.has(leaf)).toBe(true);
    });

    it("labels search matches even when they are too small to make the cut", () => {
      const { nodes, edges } = hubAndSatellites(300);
      const matches = new Set(["n270", "n271", "n272"]);

      const labeled = selectLabeledNodeIds(nodes, edges, null, null, matches);

      expect([...matches].every((id) => labeled.has(id))).toBe(true);
    });
  });
});

// Three real bugs in this file's own thinning/reveal machinery, separate
// from selectLabeledNodeIds itself. Same standing-regression rationale as
// above — this file gets re-tuned often, and each of these bugs is exactly
// the kind of thing a future re-tune could silently reintroduce without a
// test to catch it.

describe("computeDegrees", () => {
  // The bug: a self-loop edge (source === target) hit both the
  // `deg[e.source]++` and `deg[e.target]++` lines, since both refer to the
  // same node, double-counting one real edge as two. That inflates
  // nodeRadius sizing and the "{deg} edges" caption for any node with a
  // self-loop. Verified this test actually catches the regression by
  // reverting the fix locally (dropping the `source === target` branch back
  // to two unconditional increments) and confirming it goes red before
  // restoring the fix.
  it("counts a self-loop as one edge, not two", () => {
    const nodeIds = ["a", "b"];
    const edges = [
      { source: "a", target: "a" }, // self-loop
      { source: "a", target: "b" },
    ];

    const degrees = computeDegrees(nodeIds, edges);

    expect(degrees.a).toBe(2); // 1 for the self-loop + 1 for a-b
    expect(degrees.b).toBe(1);
  });

  it("counts each self-loop on the same node once each, not twice each", () => {
    const nodeIds = ["a", "b"];
    const edges = [
      { source: "a", target: "a" },
      { source: "a", target: "a" },
      { source: "a", target: "b" },
    ];

    expect(computeDegrees(nodeIds, edges).a).toBe(3); // 2 self-loops + 1 real edge
  });

  it("still counts both ends of an ordinary edge (sanity check against over-fixing)", () => {
    const nodeIds = ["a", "b", "c"];
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];

    const degrees = computeDegrees(nodeIds, edges);

    expect(degrees).toEqual({ a: 1, b: 2, c: 1 });
  });
});

describe("visibleNodes", () => {
  it("returns every node when there is no focus", () => {
    const { nodes } = hubAndSatellites(10);
    expect(visibleNodes(nodes, null)).toEqual(nodes);
  });

  it("returns only the nodes inside the focus set", () => {
    const { nodes } = hubAndSatellites(10);
    const focusSet = new Set(["n0", "n1", "n2"]);

    const visible = visibleNodes(nodes, focusSet);

    expect(visible.map((n) => n.uuid).sort()).toEqual(["n0", "n1", "n2"]);
  });

  // The actual bug this fixes: visibleNodeCount (feeding labelDensityActive)
  // and selectLabeledNodeIds's own internal `visible` used two independently
  // written copies of "focusSet ? nodes.filter(...) : nodes", nothing kept
  // them in sync. Now both call this one function, so the count that decides
  // *whether* thinning is active and the set thinning actually thins can't
  // disagree about what "visible" means. This test pins that: the count this
  // function reports crossing the threshold must line up exactly with
  // selectLabeledNodeIds switching from "label everyone" to "thin to 40".
  it("agrees with selectLabeledNodeIds about exactly when the threshold is crossed", () => {
    const { nodes, edges } = hubAndSatellites(300);
    const atThreshold = new Set(["n0", ...Array.from({ length: 39 }, (_, i) => `n${i + 1}`)]);
    const overThreshold = new Set(["n0", ...Array.from({ length: 40 }, (_, i) => `n${i + 1}`)]);

    expect(visibleNodes(nodes, atThreshold).length).toBe(THRESHOLD);
    expect(selectLabeledNodeIds(nodes, edges, atThreshold, null, null).size).toBe(THRESHOLD);

    expect(visibleNodes(nodes, overThreshold).length).toBe(THRESHOLD + 1);
    expect(selectLabeledNodeIds(nodes, edges, overThreshold, null, null).size).toBe(THRESHOLD);
  });
});

describe("selectZoomRevealedNodeIds", () => {
  // Mirrors graph-explorer's own module-scope canvas constants (W = 900,
  // H = 540): the SVG viewBox is fixed at "0 0 900 540", and a node's own
  // <g> is positioned by `translate(pan.x, pan.y) scale(zoom)` applied to
  // its world-space pos — so a node is "in frame" exactly when
  // pan + pos*zoom lands inside that box.

  // A grid of on-screen positions, 15 columns × up to 6 rows (enough for 90
  // nodes) that stays comfortably inside the 900x540 frame at zoom 1, pan 0 —
  // max x = 20 + 14*55 = 790, max y = 20 + 5*45 = 245.
  function gridPositions(ids: string[]): Record<string, { x: number; y: number }> {
    const pos: Record<string, { x: number; y: number }> = {};
    ids.forEach((id, i) => {
      pos[id] = { x: 20 + (i % 15) * 55, y: 20 + Math.floor(i / 15) * 45 };
    });
    return pos;
  }

  it("excludes a node outside the current pan+zoom frame even when it has the highest degree", () => {
    const { nodes, edges } = hubAndSatellites(10); // n0 is the hub, highest degree
    const pos = gridPositions(nodes.map((n) => n.uuid));
    pos.n0 = { x: 50_000, y: 50_000 }; // push the hub itself off-screen
    const degrees = computeDegrees(
      nodes.map((n) => n.uuid),
      edges,
    );

    const revealed = selectZoomRevealedNodeIds(nodes, pos, 1, { x: 0, y: 0 }, degrees, null);

    expect(revealed.has("n0")).toBe(false);
    expect(revealed.has("n1")).toBe(true);
  });

  it("keeps every in-frame node when the in-frame count is at or below the threshold", () => {
    const { nodes, edges } = hubAndSatellites(10);
    const pos = gridPositions(nodes.map((n) => n.uuid));
    const degrees = computeDegrees(
      nodes.map((n) => n.uuid),
      edges,
    );

    const revealed = selectZoomRevealedNodeIds(nodes, pos, 1, { x: 0, y: 0 }, degrees, null);

    expect(revealed.size).toBe(10);
  });

  // The actual measured overshoot: a centred
  // scroll on the densest node put ~70 labels on screen at once at the exact
  // ZOOM_LABEL_REVEAL crossing on a 300-node graph, well over this file's own
  // 40-label cap. Reproduced here with 70 nodes genuinely positioned inside
  // the frame (not gated by focus or by any other filter) to prove the cap
  // is real viewport culling, not a re-statement of the focus-based cap
  // already covered by selectLabeledNodeIds above.
  it("caps to the top 40 by degree among in-frame nodes when the in-frame count overshoots", () => {
    const { nodes, edges } = tieredHubs(12); // 90 nodes, degrees 1..12, all placed on-screen below
    const pos = gridPositions(nodes.map((n) => n.uuid));
    const degrees = computeDegrees(
      nodes.map((n) => n.uuid),
      edges,
    );

    const revealed = selectZoomRevealedNodeIds(nodes, pos, 1, { x: 0, y: 0 }, degrees, null);

    expect(revealed.size).toBe(THRESHOLD);
    expect(revealed.has("h11")).toBe(true); // the biggest hub always survives the cut
    const kept = nodes.filter((n) => revealed.has(n.uuid)).map((n) => degrees[n.uuid]);
    const dropped = nodes.filter((n) => !revealed.has(n.uuid)).map((n) => degrees[n.uuid]);
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(Math.max(...dropped));
  });

  it("re-includes a node once zooming out brings it back inside the frame", () => {
    const { nodes, edges } = hubAndSatellites(2);
    const pos = { n0: { x: 2000, y: 2000 }, n1: { x: 40, y: 40 } };
    const degrees = computeDegrees(
      nodes.map((n) => n.uuid),
      edges,
    );

    const zoomedIn = selectZoomRevealedNodeIds(nodes, pos, 1, { x: 0, y: 0 }, degrees, null);
    expect(zoomedIn.has("n0")).toBe(false); // 2000 * 1 = 2000, off the 900x540 frame

    const zoomedOut = selectZoomRevealedNodeIds(nodes, pos, 0.2, { x: 0, y: 0 }, degrees, null);
    expect(zoomedOut.has("n0")).toBe(true); // 2000 * 0.2 = 400, back inside the frame
  });

  it("respects an active focus the same way selectLabeledNodeIds does", () => {
    const { nodes, edges } = hubAndSatellites(10);
    const pos = gridPositions(nodes.map((n) => n.uuid));
    const degrees = computeDegrees(
      nodes.map((n) => n.uuid),
      edges,
    );
    const focusSet = new Set(["n0", "n1", "n2"]);

    const revealed = selectZoomRevealedNodeIds(nodes, pos, 1, { x: 0, y: 0 }, degrees, focusSet);

    expect([...revealed].sort()).toEqual(["n0", "n1", "n2"]);
  });
});
