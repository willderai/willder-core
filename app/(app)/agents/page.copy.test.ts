// The agents page must not tell a user to use a feature the app no longer has.
//
// The Era 1 outbound-sales cut deleted campaigns and the research-to-outreach
// handoff event, but the page kept telling users to "start a campaign" and kept
// an explainer describing that pipeline. Copy is just strings, so nothing
// failed at build time. This reads the page source and fails if the removed
// instructions come back while their feature is still gone.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = join(__dirname, "page.tsx");
const APP = join(__dirname, "..", "..");

describe("agents page copy", () => {
  const source = readFileSync(PAGE, "utf8");

  it("does not tell users to start a campaign while no campaigns page exists", () => {
    const campaignsExist = existsSync(join(APP, "(app)", "campaigns")) || existsSync(join(APP, "api", "campaigns"));
    if (campaignsExist) return;
    expect(source).not.toMatch(/start a campaign/i);
    expect(source).not.toMatch(/runs inside campaigns/i);
  });

  it("does not describe the removed research-to-outreach handoff event", () => {
    expect(source).not.toContain("agent/handoff");
  });
});
