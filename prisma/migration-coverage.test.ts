// Every model in schema.prisma must have a migration that creates its table.
//
// A table that only ever reaches production through an ad-hoc `prisma db push` is missing
// from every database built from the migration history alone (a new developer, staging,
// DR), and nothing else in CI notices.
//
// This guard closes that class without needing a database: it reads the table name every model
// declares and asserts some migration mentions it in a CREATE TABLE. It cannot prove a migration
// is *correct* -- that is what `prisma migrate diff` against a replayed database does -- only
// that a model is not missing one entirely.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const prismaDir = resolve(__dirname);
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
const migrationsDir = join(prismaDir, "migrations");

/**
 * Table name for every model in the schema: the `@@map("...")` value when a model
 * declares one, otherwise the model's own name, which is what Prisma falls back to.
 */
function declaredTables(): string[] {
  const tables: string[] = [];
  for (const block of schema.split(/^model /m).slice(1)) {
    const modelName = block.slice(0, block.search(/\s/));
    const body = block.slice(0, block.indexOf("\n}"));
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    tables.push(mapped ? mapped[1] : modelName);
  }
  return tables;
}

/** Every table name any migration creates, whether or not the CREATE is guarded. */
function createdTables(): Set<string> {
  const created = new Set<string>();
  for (const dir of readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sql = readFileSync(join(migrationsDir, dir.name, "migration.sql"), "utf8");
    for (const [, table] of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/gi)) {
      created.add(table);
    }
  }
  return created;
}

describe("migration coverage", () => {
  // Guards the two readers above against silently matching nothing, which would make
  // every assertion below pass for the wrong reason.
  it("reads models from the schema and CREATE TABLEs from the migrations", () => {
    expect(declaredTables().length).toBeGreaterThan(20);
    expect(createdTables().size).toBeGreaterThan(20);
  });

  it("creates a table for every model in schema.prisma", () => {
    const created = createdTables();
    const missing = declaredTables().filter((table) => !created.has(table));
    expect(missing).toEqual([]);
  });

  it.each(["org_roles", "entity_aliases", "founder_interest"])(
    "creates %s, the table this guard was written for",
    (table) => {
      expect(createdTables().has(table)).toBe(true);
    },
  );
});
