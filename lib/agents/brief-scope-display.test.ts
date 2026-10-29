import { describe, expect, it } from "vitest";
import { briefScopeDisplay } from "./brief-scope-display";

describe("briefScopeDisplay", () => {
  it("shows the host label for a scope-less QA brief instead of the raw org root path", () => {
    const brief = { scopePath: "org_cabc123def456", scopeLabel: "(target) petstore.swagger.io" };
    expect(briefScopeDisplay(brief)).toBe("(target) petstore.swagger.io");
  });

  it("falls back to scopePath when scopeLabel is null (a real memory scope was given)", () => {
    const brief = { scopePath: "org_cabc123.projects.backend", scopeLabel: null };
    expect(briefScopeDisplay(brief)).toBe("org_cabc123.projects.backend");
  });

  it("falls back to scopePath when scopeLabel is undefined (older brief payload without the field)", () => {
    const brief = { scopePath: "org_cabc123.projects.backend" };
    expect(briefScopeDisplay(brief)).toBe("org_cabc123.projects.backend");
  });
});
