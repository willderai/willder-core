// docker-compose.yml holds what docs/self-host.md says about it: the database images CI
// tests against, ports on 127.0.0.1 only, Neo4j's usage report and Graphiti's telemetry
// off, and defaults .env.selfhost.example agrees with. Whether the stack starts and calls
// nothing outside is the Self-host workflow's job (.github/workflows/selfhost.yml). Both
// files are read as text, as scripts/ci-realdb-coverage.test.ts reads ci.yml.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const example = parseEnv(readFileSync(".env.selfhost.example", "utf8"));

const images = (text: string, name: string) => [
  ...new Set([...text.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]).filter((i) => i.startsWith(name))),
];
const published = [...compose.matchAll(/^\s*- "([^"]*:\d+)"$/gm)].map((m) => m[1]);

describe("docker-compose.yml", () => {
  it.each(["pgvector/pgvector:", "neo4j:"])("runs the %s image CI tests against", (name) => {
    expect(images(compose, name)).toHaveLength(1);
    expect(images(ci, name)).toEqual(images(compose, name));
  });

  it("builds the memory service from its Dockerfile", () => {
    expect(compose).toMatch(/^ {4}build: \.\/memory-service$/m);
  });

  it("publishes Postgres and the memory service on 127.0.0.1 only, at the example's ports, and Neo4j not at all", () => {
    const db = new URL(example.DATABASE_URL!);
    const memory = new URL(example.GRAPHITI_SERVICE_URL!);
    expect(published).toEqual([
      `127.0.0.1:\${WILLDER_POSTGRES_PORT:-${db.port}}:5432`,
      `127.0.0.1:\${WILLDER_MEMORY_PORT:-${memory.port}}:8000`,
    ]);
    expect(compose).not.toMatch(/7687:|7474:/);
  });

  it("matches the example's database credentials, and the example writes inline", () => {
    const db = new URL(example.DATABASE_URL!);
    expect(compose).toContain(`POSTGRES_USER: ${db.username}`);
    expect(compose).toContain(`POSTGRES_PASSWORD: \${WILLDER_POSTGRES_PASSWORD:-${db.password}}`);
    expect(compose).toContain(`POSTGRES_DB: ${db.pathname.slice(1)}`);
    expect(example.DATABASE_URL_UNPOOLED).toBe(example.DATABASE_URL);
    expect(example.INNGEST_BYPASS).toBe("1");
  });

  it.each([
    ["Neo4j's usage report", 'NEO4J_dbms_usage__report_enabled: "false"'],
    ["Graphiti's telemetry", 'GRAPHITI_TELEMETRY_ENABLED: "false"'],
    ["model downloads", 'HF_HUB_OFFLINE: "1"'],
  ])("turns off %s", (_label, line) => {
    expect(compose).toContain(line);
  });
});
