// Completion claims in common agent wording that claimsCompletion must read as claims.
import { describe, expect, it } from "vitest";
import { claimsCompletion } from "@/services/memory/session-state";

const CLAIMS = [
  "I can confirm the prune is fixed.",
  "I can confirm it's done.",
  "Everything needed is done.",
  "All changes requested are done.",
  "Redirect prune: all tests pass, ready to merge.",
  "The prune is complete and tested.",
  "Merged the redirect prune; all tests green.",
  "The redirect prune is in and working.",
  "Task completed successfully",
  "Prune landed. Tests pass.",
  "Work is wrapped up.",
  "All set: redirect prune shipped",
  "Everything you asked to be fixed is fixed.",
  "This is now finished, without regressions.",
  "Finished — no regressions.",
  "Done. Not touching CHANGELOG.md.",
  "The bug can no longer reproduce; fixed.",
];
describe("completion claims in common wording read as claims", () => {
  for (const text of CLAIMS) it(text, () => expect(claimsCompletion(text)).toBe(true));
});
