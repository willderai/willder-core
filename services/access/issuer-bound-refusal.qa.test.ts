// isIssuerBoundRefusal(): only the issuer-bound trigger's own
// refusal may become a 403 at a mint path. Postgres raises the same SQLSTATE
// (42501, insufficient_privilege) for any permission failure, such as a missing
// table grant or a row-level security policy; those are faults to surface as a
// 500, not a "you do not hold this permission" answer to the caller.
import { describe, expect, it } from "vitest";
import { isIssuerBoundRefusal } from "./capabilities";

const refusal = { code: "42501", message: "capability wider than its issuer" };

describe("isIssuerBoundRefusal", () => {
  it("recognises the trigger's refusal, directly or wrapped by the driver", () => {
    expect(isIssuerBoundRefusal(refusal)).toBe(true);
    expect(isIssuerBoundRefusal({ message: "query failed", cause: refusal })).toBe(true);
    expect(isIssuerBoundRefusal({ originalCode: "42501", message: refusal.message })).toBe(true);
  });

  it("does not read any other insufficient_privilege error as the issuer bound", () => {
    expect(isIssuerBoundRefusal({ code: "42501", message: "permission denied for table capabilities" })).toBe(false);
    expect(
      isIssuerBoundRefusal({
        message: "query failed",
        cause: { code: "42501", message: "new row violates row-level security policy" },
      }),
    ).toBe(false);
  });

  it("does not read the refusal's text under another SQLSTATE as the issuer bound", () => {
    expect(isIssuerBoundRefusal({ code: "P0001", message: refusal.message })).toBe(false);
  });
});
