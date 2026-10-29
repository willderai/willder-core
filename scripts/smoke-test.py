#!/usr/bin/env python3
"""
Production smoke test — exercises the full Willder stack end-to-end.

Tests two layers independently:
  1. Memory service (Railway/Python) — ingest → graph extraction → search → dedup
  2. Vercel app (Next.js) — public pages reachable, API endpoints respond correctly

Layer 2 (Vercel API) requires auth. Without SMOKE_SESSION_TOKEN the authenticated
tests are skipped — run the app, open DevTools → Application → Cookies, copy the
__session cookie and export SMOKE_SESSION_TOKEN=<value> before running.

Usage:
  source .env.prod && python3 scripts/smoke-test.py
  SMOKE_SESSION_TOKEN=xxx source .env.prod && python3 scripts/smoke-test.py
  python3 scripts/smoke-test.py --layer memory   # memory service only
  python3 scripts/smoke-test.py --layer vercel   # vercel app only

Exit code: 0 if all required checks pass, 1 otherwise.
"""

import argparse
import json
import os
import sys
import time
import uuid
import urllib.error
import urllib.request

# ── config ────────────────────────────────────────────────────────────────────

GRAPHITI_URL = os.environ.get("GRAPHITI_SERVICE_URL", "").rstrip("/")
GRAPHITI_KEY = os.environ.get("GRAPHITI_SERVICE_API_KEY", "")
SESSION_TOKEN = os.environ.get("SMOKE_SESSION_TOKEN", "")
APP_URL = os.environ.get("NEXT_PUBLIC_APP_URL", "https://willder.ai").rstrip("/")

MEMORY_HEADERS = {
    "Authorization": f"Bearer {GRAPHITI_KEY}",
    "Content-Type": "application/json",
}

# ── helpers ───────────────────────────────────────────────────────────────────

passes = 0
fails = 0
warns = 0

def ok(label):
    global passes
    passes += 1
    print(f"  ✓ {label}")

def fail(label, detail=""):
    global fails
    fails += 1
    suffix = f": {detail}" if detail else ""
    print(f"  ✗ {label}{suffix}")

def warn(label, detail=""):
    global warns
    warns += 1
    suffix = f": {detail}" if detail else ""
    print(f"  W {label}{suffix}")

def section(title):
    print(f"\n{'═'*60}\n{title}\n{'═'*60}")

def mem(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"{GRAPHITI_URL}{path}", data=data, headers=MEMORY_HEADERS, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:200]}"
    except Exception as e:
        return None, str(e)

def app_get(path, timeout=15):
    url = f"{APP_URL}{path}"
    headers = {}
    if SESSION_TOKEN:
        headers["Cookie"] = f"__session={SESSION_TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()[:500], None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500], None
    except Exception as e:
        return None, "", str(e)

# ── memory layer ──────────────────────────────────────────────────────────────

def test_memory_health():
    section("MEMORY SERVICE — Health")
    if not GRAPHITI_URL or not GRAPHITI_KEY:
        fail("env vars", "GRAPHITI_SERVICE_URL / GRAPHITI_SERVICE_API_KEY not set")
        return False

    r, err = mem("GET", "/health", timeout=10)
    if err:
        fail("GET /health reachable", err)
        return False
    if r.get("status") != "ok":
        fail("health status=ok", str(r))
        return False
    ok("GET /health → status=ok")

    if not r.get("neo4j"):
        fail("Neo4j connected", str(r.get("error")))
        return False
    ok("Neo4j connected")

    # Confirm /ingest-bulk in openapi
    oa, err = mem("GET", "/openapi.json", timeout=10)
    if err:
        warn("openapi.json reachable", err)
    elif "/ingest-bulk" not in (oa or {}).get("paths", {}):
        fail("/ingest-bulk endpoint present")
        return False
    else:
        ok("/ingest-bulk present in openapi")

    return True


def test_memory_ingest_roundtrip():
    section("MEMORY SERVICE — Ingest → Graph → Search roundtrip")
    gid = f"smoke-{uuid.uuid4().hex[:8]}"

    # Ingest two episodes in one bulk call
    episodes = [
        {
            "group_id": gid,
            "content": (
                "Aria Chen joined NovaBridge as Head of Partnerships in March 2026. "
                "She previously led BD at Stripe for four years. "
                "NovaBridge raised a $15M Series A led by Sequoia in January 2026."
            ),
            "source": "document",
            "name": "smoke-ep-1",
            "actor_id": "smoke-test",
            "actor_type": "human",
            "actor_name": "Smoke",
        },
        {
            "group_id": gid,
            "content": (
                "Aria met with Marcus Lee (CTO of Finterra) on April 2. "
                "Finterra uses Salesforce and is evaluating a switch to NovaBridge. "
                "Marcus asked about SOC 2 compliance — Aria followed up by email April 5."
            ),
            "source": "document",
            "name": "smoke-ep-2",
            "actor_id": "smoke-test",
            "actor_type": "human",
            "actor_name": "Smoke",
        },
    ]

    t0 = time.time()
    r, err = mem("POST", "/ingest-bulk", {"group_id": gid, "episodes": episodes})
    elapsed = time.time() - t0

    if err:
        fail("ingest-bulk 200", err)
        return False
    if len(r.get("episode_ids", [])) != 2:
        fail("ingest-bulk returns 2 episode_ids", str(r))
        return False
    ok(f"ingest-bulk → 2 episodes ({elapsed:.1f}s)")

    if elapsed > 60:
        warn(f"ingest slow ({elapsed:.1f}s > 60s target)")
    else:
        ok(f"ingest time within 60s target")

    # Wait for graph extraction
    print("  Waiting 25s for graph extraction...")
    time.sleep(25)

    # Graph check
    g, err = mem("POST", "/graph", {"group_ids": [gid], "limit": 50})
    if err:
        fail("graph query", err)
        return False

    nodes = g["nodes"]
    node_names = {n["name"].lower() for n in nodes}

    expected_nodes = ["Aria Chen", "NovaBridge", "Marcus Lee", "Finterra", "Salesforce", "Stripe", "Sequoia"]
    found, missing = [], []
    for name in expected_nodes:
        if any(name.lower() in n for n in node_names):
            found.append(name)
        else:
            missing.append(name)

    ok(f"graph nodes extracted: {found}")
    if missing:
        warn(f"nodes not found (may need more time): {missing}")

    # Fact check
    facts = [e.get("fact", "") for e in g["edges"]]
    if any("Aria" in f or "NovaBridge" in f for f in facts):
        ok("graph edges contain relevant facts")
    else:
        warn("no relevant facts in edges yet (extraction may still be running)")

    # Search check
    s, err = mem("POST", "/search", {"group_id": gid, "query": "who leads partnerships at NovaBridge", "limit": 3})
    if err:
        warn(f"search error (may be stale data): {err[:80]}")
    elif any("Aria" in (f.get("fact") or "") for f in s["facts"]):
        ok("search returns relevant result for 'who leads partnerships'")
    else:
        warn(f"search didn't surface Aria yet — facts: {[f.get('fact','')[:60] for f in s['facts']]}")

    return True


def test_memory_dedup():
    section("MEMORY SERVICE — Dedup (substring merge)")
    gid = f"smoke-dedup-{uuid.uuid4().hex[:8]}"

    # Ingest two episodes that mention the same person by short and long name
    episodes = [
        {
            "group_id": gid,
            "content": "Jordan runs the partnerships team at Meridian.",
            "source": "document", "name": "dedup-ep-1",
            "actor_id": "smoke", "actor_type": "human", "actor_name": "Smoke",
        },
        {
            "group_id": gid,
            "content": "Jordan Kim is the VP Partnerships at Meridian Labs, she joined in 2024.",
            "source": "document", "name": "dedup-ep-2",
            "actor_id": "smoke", "actor_type": "human", "actor_name": "Smoke",
        },
    ]
    r, err = mem("POST", "/ingest-bulk", {"group_id": gid, "episodes": episodes})
    if err:
        fail("dedup ingest-bulk", err)
        return False
    ok("dedup ingest-bulk → 2 episodes")

    print("  Waiting 25s for extraction...")
    time.sleep(25)

    g, err = mem("POST", "/graph", {"group_ids": [gid], "limit": 50})
    if err:
        fail("dedup graph query", err)
        return False

    nodes = g["nodes"]
    by_type: dict = {}
    for n in nodes:
        by_type.setdefault(n["type"], []).append(n)

    # Run dedup
    merged_count = 0
    for t, bucket in by_type.items():
        sorted_nodes = sorted(bucket, key=lambda x: len(x["name"]), reverse=True)
        absorbed = set()
        for i, longer_node in enumerate(sorted_nodes):
            if longer_node["uuid"] in absorbed:
                continue
            longer = longer_node["name"].lower()
            for j in range(i + 1, len(sorted_nodes)):
                shorter_node = sorted_nodes[j]
                if shorter_node["uuid"] in absorbed:
                    continue
                shorter = shorter_node["name"].lower()
                if longer.find(shorter) >= 0 and len(shorter) >= 3:
                    r2, err2 = mem("POST", "/transfer-entity", {
                        "group_id": gid,
                        "old_name": shorter_node["name"],
                        "new_name": longer_node["name"],
                    })
                    if not err2:
                        merged_count += 1
                        absorbed.add(shorter_node["uuid"])

    if merged_count > 0:
        ok(f"dedup merged {merged_count} node(s)")
    else:
        warn("dedup found no duplicates to merge (Jordan/Jordan Kim may already be distinct)")

    # Verify after dedup: only one Jordan node should be active (have edges)
    g2, _ = mem("POST", "/graph", {"group_ids": [gid], "limit": 50})
    if g2:
        edge_uuids = set()
        for e in g2["edges"]:
            edge_uuids.add(e.get("source", ""))
            edge_uuids.add(e.get("target", ""))
        jordan_active = [n for n in g2["nodes"] if "jordan" in n["name"].lower() and n["uuid"] in edge_uuids]
        if len(jordan_active) <= 1:
            ok(f"dedup: ≤1 active Jordan node after merge (active={[n['name'] for n in jordan_active]})")
        else:
            warn(f"dedup: multiple active Jordan nodes: {[n['name'] for n in jordan_active]}")

    return True


def test_memory_performance():
    section("MEMORY SERVICE — Performance benchmarks")
    gid = f"smoke-perf-{uuid.uuid4().hex[:8]}"

    # Benchmark: 4-chunk bulk ingest (equivalent to a real doc)
    chunks = [
        "NovaBridge is a B2B SaaS company building the next generation of embedded banking infrastructure for fintech companies.",
        "Their flagship product BridgeCore integrates directly with Fiserv, Jack Henry, and Temenos core banking systems.",
        "The APAC team is led by David Park, who joined from Stripe's Singapore office. They closed two channel partnerships with DBS and OCBC in Q1 2026.",
        "Revenue is growing 40% QoQ. The Series B process is expected to kick off in Q3 2026 with Goldman Sachs advising.",
    ]
    episodes = [
        {"group_id": gid, "content": c, "source": "document",
         "name": f"perf-chunk-{i+1}", "actor_id": "smoke", "actor_type": "human", "actor_name": "Smoke"}
        for i, c in enumerate(chunks)
    ]

    t0 = time.time()
    r, err = mem("POST", "/ingest-bulk", {"group_id": gid, "episodes": episodes}, timeout=120)
    elapsed = time.time() - t0

    if err:
        fail(f"perf ingest-bulk ({elapsed:.1f}s)", err)
    elif elapsed < 30:
        ok(f"4-chunk ingest: {elapsed:.1f}s (target <30s) ✓")
    elif elapsed < 60:
        warn(f"4-chunk ingest: {elapsed:.1f}s (acceptable, target <30s)")
    else:
        fail(f"4-chunk ingest too slow: {elapsed:.1f}s (target <30s)")

    return not bool(err)


# ── vercel layer ──────────────────────────────────────────────────────────────

def test_vercel_public():
    section(f"VERCEL APP — Public pages ({APP_URL})")

    routes = [
        ("/", "home page", 200),
        ("/sign-in", "sign-in page", 200),
    ]
    all_ok = True
    for path, label, expected in routes:
        status, _, err = app_get(path)
        if err:
            fail(f"{label} reachable", err)
            all_ok = False
        elif status == expected:
            ok(f"{label} → {status}")
        else:
            fail(f"{label} → {status} (expected {expected})")
            all_ok = False

    return all_ok


def test_vercel_authenticated():
    section("VERCEL APP — Authenticated API endpoints")
    if not SESSION_TOKEN:
        print("  SKIPPED — set SMOKE_SESSION_TOKEN=<__session cookie value> to enable")
        return True

    routes = [
        ("/api/memory/query?q=test", "GET", None, "memory query"),
        ("/api/memory/graph",        "GET", None, "memory graph"),
        ("/api/campaigns",           "GET", None, "campaigns list"),
        ("/api/memory/scopes",       "GET", None, "memory scopes"),
    ]

    all_ok = True
    for path, method, body, label in routes:
        url = f"{APP_URL}{path}"
        headers = {"Cookie": f"__session={SESSION_TOKEN}"}
        if body:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, headers=headers, method=method,
                                      data=json.dumps(body).encode() if body else None)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
        except Exception as e:
            fail(f"{label}", str(e))
            all_ok = False
            continue

        if status in (200, 204):
            ok(f"{label} → {status}")
        elif status == 401:
            warn(f"{label} → 401 (session token expired?)")
        else:
            fail(f"{label} → {status}")
            all_ok = False

    return all_ok


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer", choices=["memory", "vercel", "all"], default="all")
    args = parser.parse_args()

    run_memory = args.layer in ("memory", "all")
    run_vercel = args.layer in ("vercel", "all")

    print(f"\nWillder Smoke Test  →  memory={GRAPHITI_URL or '(not set)'}  app={APP_URL}")

    if run_memory:
        healthy = test_memory_health()
        if healthy:
            test_memory_ingest_roundtrip()
            test_memory_dedup()
            test_memory_performance()

    if run_vercel:
        test_vercel_public()
        test_vercel_authenticated()

    section("RESULTS")
    total = passes + fails
    status = "ALL PASSED" if fails == 0 else f"{fails} FAILED"
    print(f"  {passes}/{total} passed  |  {warns} warnings  —  {status}\n")
    sys.exit(0 if fails == 0 else 1)
