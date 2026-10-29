// Memory-service connectivity check. Run with: npm run memory:check
// Verifies the Python memory-service is up, Neo4j is reachable, and the TS
// MemoryStore client can reach it over HTTP.
//
// Start the service first (separate terminal):
//   cd memory-service && source .venv/bin/activate
//   set -a && . ../.env && set +a
//   uvicorn app.main:app --port 8000
import { memory, MemoryServiceError } from "@/services/memory";

const BASE = process.env.GRAPHITI_SERVICE_URL ?? "";

const START_HINT =
  "Start it:\n" +
  "  cd memory-service && source .venv/bin/activate\n" +
  "  set -a && . ../.env && set +a\n" +
  "  uvicorn app.main:app --port 8000";

async function main() {
  console.log(`Checking memory-service at ${BASE || "(GRAPHITI_SERVICE_URL unset)"}...`);
  if (!BASE) throw new Error("GRAPHITI_SERVICE_URL is not set in .env");

  // 1. Health (unauthenticated). Pings Neo4j.
  let health: {
    status?: string;
    neo4j?: boolean;
    error?: string | null;
    extraction?: { status?: string; reason?: string | null; detail?: string | null };
  };
  try {
    const res = await fetch(`${BASE}/health`);
    health = await res.json();
  } catch {
    throw new Error(`cannot reach ${BASE}.\n${START_HINT}`);
  }
  console.log(
    `  /health: status=${health.status} neo4j=${health.neo4j}` + (health.error ? ` error=${health.error}` : ""),
  );
  if (!health.neo4j) {
    console.log("  WARN: Neo4j not connected — check NEO4J_* and that AuraDB is resumed");
  }
  if (health.extraction?.status === "degraded") {
    console.log(`  WARN: graph extraction degraded (${health.extraction.reason}): ${health.extraction.detail}`);
  }

  // 2. The TS MemoryStore client over HTTP (auth + mapping).
  try {
    await memory.ingest({
      groupId: "__check__",
      content: "ping",
      actorType: "extraction",
      origin: "script",
      actorId: "__check__",
    });
    console.log("  MemoryStore.ingest: OK");
  } catch (e) {
    if (e instanceof MemoryServiceError) {
      console.log(`  MemoryStore.ingest -> ${e.status} UNEXPECTED`);
      throw e;
    } else {
      throw e;
    }
  }

  console.log("Memory service reachable.");
}

main().catch((e) => {
  console.error("Memory check FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
