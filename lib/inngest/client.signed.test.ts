import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Production carries a real signing key, so the refusal that matters there is
// the signature check itself, not a missing-key error. These drive the real SDK
// handler with a key configured: an unsigned or wrongly signed call must not run
// the job, and a correctly signed one still must, or the pin would break
// production jobs instead of protecting them. The SDK signs the canonical JSON
// form of the body (sorted keys, no whitespace), so the helper does the same.

const SIGNING_KEY = "signkey-prod-" + "ab".repeat(32);
const ran = vi.fn();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sign(body: string, key: string): string {
  const ts = Math.round(Date.now() / 1000).toString();
  const mac = createHmac("sha256", key.replace(/^signkey-[\w]+-/, ""))
    .update(canonical(JSON.parse(body)))
    .update(ts)
    .digest("hex");
  return `t=${ts}&s=${mac}`;
}

async function jobCall(signature?: (body: string) => string): Promise<{ status: number }> {
  vi.resetModules();
  const { inngest } = await import("./client");
  const { serve } = await import("inngest/next");
  const probe = inngest.createFunction({ id: "probe", triggers: [{ event: "test/probe" }] }, async () => {
    ran();
    return "ran";
  });
  const { POST } = serve({ client: inngest, functions: [probe] });

  const url = `https://willder.example/api/inngest?fnId=${encodeURIComponent(`${inngest.id}-probe`)}&stepId=step`;
  const body = JSON.stringify({
    event: { name: "test/probe", data: {} },
    events: [{ name: "test/probe", data: {} }],
    steps: {},
    ctx: {
      run_id: "run_probe",
      attempt: 0,
      disable_immediate_execution: true,
      use_api: false,
      stack: { stack: [], current: 0 },
    },
    version: 1,
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-inngest-signature"] = signature(body);
  const req = new NextRequest(url, { method: "POST", headers, body });
  const res = await POST(req, {});
  return { status: res.status };
}

function deployedWithKey() {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("INNGEST_DEV", "1");
  vi.stubEnv("INNGEST_SIGNING_KEY", SIGNING_KEY);
}

describe("the Inngest client on a deployment with a signing key", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    ran.mockReset();
  });

  it("refuses an unsigned job call with 401", async () => {
    deployedWithKey();
    const { status } = await jobCall();
    expect(status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });

  it("refuses a call signed with the wrong key", async () => {
    deployedWithKey();
    const { status } = await jobCall((body) => sign(body, "signkey-prod-" + "cd".repeat(32)));
    expect(status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });

  it("runs a correctly signed job call", async () => {
    deployedWithKey();
    const { status } = await jobCall((body) => sign(body, SIGNING_KEY));
    expect(status).toBeLessThan(300);
    expect(ran).toHaveBeenCalledOnce();
  });
});
