import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The seam is the served endpoint: an unsigned request asking Inngest's handler
// to run a job. In dev mode the SDK skips signature verification, so the only
// thing standing between a deployed /api/inngest and an anonymous caller is the
// mode the client resolves to. These tests drive the real SDK handler, not a mock.

const ran = vi.fn();

async function unsignedJobCall(): Promise<{ status: number }> {
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
  const req = new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const res = await POST(req, {});
  return { status: res.status };
}

describe("the Inngest client on a deployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    ran.mockReset();
  });

  it("refuses an unsigned job call on a Vercel deployment even with INNGEST_DEV set", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("INNGEST_DEV", "1");
    vi.stubEnv("INNGEST_SIGNING_KEY", "");

    const { status } = await unsignedJobCall();

    expect(status).toBeGreaterThanOrEqual(400);
    expect(ran).not.toHaveBeenCalled();
  });

  it("refuses on a preview deployment too, which is just as reachable", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("INNGEST_DEV", "1");
    vi.stubEnv("INNGEST_SIGNING_KEY", "");

    const { status } = await unsignedJobCall();

    expect(status).toBeGreaterThanOrEqual(400);
    expect(ran).not.toHaveBeenCalled();
  });

  it("refuses on a self-hosted production build with no Vercel variables", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("INNGEST_DEV", "1");
    vi.stubEnv("INNGEST_SIGNING_KEY", "");

    const { status } = await unsignedJobCall();

    expect(status).toBeGreaterThanOrEqual(400);
    expect(ran).not.toHaveBeenCalled();
  });

  it("still runs unsigned against the local dev server under next dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("INNGEST_DEV", "1");
    vi.stubEnv("INNGEST_SIGNING_KEY", "");

    const { status } = await unsignedJobCall();

    expect(status).toBeLessThan(300);
    expect(ran).toHaveBeenCalledOnce();
  });
});
