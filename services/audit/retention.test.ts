import { describe, expect, it } from "vitest";
import { AUDIT_RETENTION_FLOOR_DAYS, AuditRetentionConfigError, auditRetentionPolicy } from "./retention";

describe("audit retention policy", () => {
  it("has a floor no shorter than the longest six calendar months", () => {
    // 1 July to 1 January is 184 days, the longest any six-month span runs.
    const longestSixMonths = (Date.UTC(2027, 0, 1) - Date.UTC(2026, 6, 1)) / 86_400_000;
    expect(AUDIT_RETENTION_FLOOR_DAYS).toBeGreaterThanOrEqual(longestSixMonths);
  });

  it("keeps audit rows forever when nothing is configured", () => {
    expect(auditRetentionPolicy({})).toEqual({ keep: "forever", floorDays: AUDIT_RETENTION_FLOOR_DAYS });
    expect(auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: "" })).toEqual({
      keep: "forever",
      floorDays: AUDIT_RETENTION_FLOOR_DAYS,
    });
    expect(auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: "forever" }).keep).toBe("forever");
  });

  it("accepts a period at or above the floor", () => {
    expect(auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: String(AUDIT_RETENTION_FLOOR_DAYS) })).toEqual({
      keep: "days",
      days: AUDIT_RETENTION_FLOOR_DAYS,
      floorDays: AUDIT_RETENTION_FLOOR_DAYS,
    });
    expect(auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: "400" })).toMatchObject({ keep: "days", days: 400 });
  });

  it.each(["183", "180", "90", "0", "-400"])("refuses %s days, which is shorter than six months", (value) => {
    expect(() => auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: value })).toThrow(AuditRetentionConfigError);
    expect(() => auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: value })).toThrow(
      /AUDIT_LOG_RETENTION_DAYS must be "forever" or a whole number of days of at least 184/,
    );
  });

  it.each(["six months", "200.5", "1e3", "200 ", "0x200", "Infinity"])(
    "refuses %j, which is not a whole number of days",
    (value) => {
      expect(() => auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: value })).toThrow(AuditRetentionConfigError);
    },
  );

  it("names the fix in one line", () => {
    try {
      auditRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: "30" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("\n");
      expect((err as Error).message).toContain('got "30"');
    }
  });
});
