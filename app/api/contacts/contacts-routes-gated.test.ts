import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every handler under /api/contacts reads or writes Contact rows, which hold
// personal data. Tenant scoping alone (requireAccessContext) is not an access
// decision: each route file must ask check() before touching a row. This
// sweep fails if a route is added, or restored, without that call, the way
// /api/contacts/[id] once served GET/PATCH/DELETE with tenant scoping only.

const CONTACTS_DIR = join(process.cwd(), "app/api/contacts");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

describe("/api/contacts route files", () => {
  const files = routeFiles(CONTACTS_DIR);

  it("sweeps a non-empty set that includes the list route", () => {
    expect(files.map((f) => relative(CONTACTS_DIR, f))).toContain("route.ts");
  });

  it.each(files.map((f) => [relative(CONTACTS_DIR, f), f]))("%s calls check() from services/access", (_name, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/from "@\/services\/access"/);
    expect(source).toMatch(/\bcheck\(/);
  });
});
