// narrowestScopePath(), the scope the OAuth connect page
// preselects: the deepest offered path, the earlier in path order on a tie, no
// matter the order the scopes arrive in.
import { describe, expect, it } from "vitest";
import { narrowestScopePath } from "./issue-capability";

const scope = (path: string) => ({ path, name: path });

describe("narrowestScopePath", () => {
  it("picks the deepest path wherever it sits in the list", () => {
    const paths = ["org_a", "org_a.sales", "org_a.sales.emea", "org_a.eng"];
    expect(narrowestScopePath(paths.map(scope))).toBe("org_a.sales.emea");
    expect(narrowestScopePath([...paths].reverse().map(scope))).toBe("org_a.sales.emea");
  });

  it("breaks a tie by path order, independent of list order", () => {
    expect(narrowestScopePath(["org_a.sales", "org_a.eng"].map(scope))).toBe("org_a.eng");
    expect(narrowestScopePath(["org_a.eng", "org_a.sales"].map(scope))).toBe("org_a.eng");
  });

  it("counts depth by segments, not by length", () => {
    expect(narrowestScopePath(["org_a.customer_success_team", "org_a.x.y"].map(scope))).toBe("org_a.x.y");
  });

  it("offers nothing for an empty list and the only path for one", () => {
    expect(narrowestScopePath([])).toBeUndefined();
    expect(narrowestScopePath([scope("org_a")])).toBe("org_a");
  });
});
