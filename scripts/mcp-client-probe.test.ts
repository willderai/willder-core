// Covers the per-client probe registry and its result shaping. No network, no
// token, no client: these tests check the parts that decide what "verified"
// is allowed to mean, which is the part a reader has to trust.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_PROBES,
  clientClaimFrom,
  findProbe,
  matrixExitCode,
  probeClient,
  readConnectConfig,
  REQUIRED_TOOLS,
  rowPasses,
  scrub,
  tally,
  type ClientProbe,
  type MatrixRow,
  type ProbeContext,
  type ProbeResult,
} from "./mcp-client-probe";
import { parseManualRuns } from "./lib/manual-runs";

const CONTEXT: ProbeContext = { url: "https://example.test/api/mcp", token: "wcap_secret_value" };

describe("the client registry", () => {
  it("covers every page under docs/connect", () => {
    const pages = readdirSync(join(__dirname, "..", "docs", "connect"))
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => name.replace(/\.md$/, ""))
      .sort();
    expect(CLIENT_PROBES.map((probe) => probe.id).sort()).toEqual(pages);
  });

  it("gives every client either a runnable probe or a reason it has none", () => {
    for (const probe of CLIENT_PROBES) {
      expect(probe.run !== undefined || probe.manualReason !== undefined).toBe(true);
    }
  });

  it("finds a client by the name of its page", () => {
    expect(findProbe("claude-code")?.label).toBe("Claude Code");
    expect(findProbe("not-a-client")).toBeUndefined();
  });
});

describe("probeClient", () => {
  it("reports a client with no scriptable path as unavailable, never as a pass", async () => {
    const result = await probeClient(findProbe("cursor")!, CONTEXT);
    expect(result.status).toBe("unavailable");
    expect(result.page).toBe("docs/connect/cursor.md");
  });

  it("reports a missing command-line client as unavailable, with how to install it", async () => {
    const probe = {
      id: "hermes",
      label: "Hermes",
      requires: { bin: "definitely-not-installed-xyz", install: "Install the thing." },
      command: "probe",
      run: async () => ({ ok: true, detail: "should never run" }),
    };
    const result = await probeClient(probe, CONTEXT);
    expect(result.status).toBe("unavailable");
    expect(result.detail).toContain("Install the thing.");
  });

  it("reports a probe that threw as failed, with the token scrubbed out", async () => {
    const probe = {
      id: "claude-code",
      label: "Claude Code",
      command: "probe",
      run: async () => {
        throw new Error(`connect failed with Bearer ${CONTEXT.token}`);
      },
    };
    const result = await probeClient(probe, CONTEXT);
    expect(result.status).toBe("failed");
    expect(result.detail).not.toContain(CONTEXT.token);
  });

  it("passes a probe that connected and answered", async () => {
    const probe = {
      id: "vercel-ai-sdk",
      label: "Vercel AI SDK",
      command: "probe",
      run: async () => ({ ok: true, detail: `9 tools including ${REQUIRED_TOOLS.join(", ")}` }),
    };
    await expect(probeClient(probe, CONTEXT)).resolves.toMatchObject({ status: "verified" });
  });
});

describe("scrub", () => {
  it("removes the exact token and anything else token-shaped", () => {
    const text = `header: Bearer ${CONTEXT.token}; other: wcap_abc123DEF-_x`;
    const scrubbed = scrub(text, CONTEXT.token);
    expect(scrubbed).not.toContain(CONTEXT.token);
    expect(scrubbed).not.toContain("wcap_abc123DEF-_x");
  });

  // The shape rule alone would print a token that is not `wcap_`-prefixed, which
  // is what a client's own key or an older token format looks like.
  it("removes a token that is not token-shaped at all", () => {
    expect(scrub("header: Bearer sk-not-our-format", "sk-not-our-format")).toBe("header: Bearer <token>");
  });

  it("leaves text alone when there is no token to remove", () => {
    expect(scrub("no secret here", "")).toBe("no secret here");
  });
});

describe("the registry against the committed pages", () => {
  const root = join(__dirname, "..");

  it("names a no-config reason for exactly the pages that commit no config", () => {
    for (const probe of CLIENT_PROBES) {
      const shape = readConnectConfig(probe.id, root).shape;
      expect(probe.noConfigReason !== undefined).toBe(shape === "none");
    }
  });

  it("gives a client with a scripted end-to-end probe no manual reason, and the reverse", () => {
    for (const probe of CLIENT_PROBES) {
      const scripted = probe.run !== undefined && probe.manualReason === undefined;
      const manual = probe.manualReason !== undefined;
      expect(scripted || manual).toBe(true);
    }
  });
});

describe("the matrix verdict", () => {
  const row = (over: Partial<MatrixRow>): MatrixRow => ({
    client: "example",
    label: "Example",
    page: "docs/connect/example.md",
    transport: {
      client: "example",
      page: "docs/connect/example.md",
      path: "direct-header",
      status: "verified",
      steps: [],
      ms: 1,
    },
    client_: { verified: false, evidence: "none", detail: "no run recorded" },
    pass: false,
    ...over,
  });

  it("counts a row as passing only when both claims hold", () => {
    const rows = [
      row({ pass: true, client_: { verified: true, evidence: "scripted probe", detail: "answered" } }),
      row({}),
      row({ transport: { ...row({}).transport, status: "unsupported" } }),
      row({ transport: { ...row({}).transport, status: "not-applicable" } }),
    ];
    expect(tally(rows)).toMatchObject({
      rows: 4,
      bothClaims: 1,
      transportVerified: 2,
      transportUnsupported: 1,
      notApplicable: 1,
      clientVerified: 1,
      awaitingManualRun: 1,
    });
  });
});

describe("rowPasses", () => {
  const verified = {
    client: "example",
    page: "docs/connect/example.md",
    path: "direct-header",
    status: "verified" as const,
    steps: [],
    ms: 1,
  };

  it("passes only when both halves hold", () => {
    expect(rowPasses(verified, { verified: true, evidence: "scripted probe", detail: "answered" })).toBe(true);
  });

  it("does not pass a row whose client half is unverified, however green the transport check is", () => {
    expect(rowPasses(verified, { verified: false, evidence: "none", detail: "no run recorded" })).toBe(false);
  });

  it.each(["failed", "unsupported", "not-applicable"] as const)(
    "does not pass a row whose transport is %s, however the client half was established",
    (status) => {
      expect(
        rowPasses(
          { ...verified, status },
          { verified: true, evidence: "recorded manual run", detail: "a person ran it" },
        ),
      ).toBe(false);
    },
  );
});

describe("clientClaimFrom", () => {
  const probe = { id: "cursor", label: "Cursor", command: "probe", manualReason: "a graphical client" } as ClientProbe;
  const RUN = {
    client: "cursor",
    who: "A Person",
    when: "2026-10-05T18:00:00Z",
    deployedCommit: "1a2b3c4d",
    clientVersion: "1.2.3",
    saw: "10 tools; memory_query answered",
  };
  const options = {
    root: ".",
    ledger: parseManualRuns(JSON.stringify({ runs: [RUN] })),
    deployedCommit: "1a2b3c4d5e6f",
    endToEnd: false,
  };
  const endToEnd = (status: ProbeResult["status"]): ProbeResult => ({
    client: "cursor",
    page: "docs/connect/cursor.md",
    status,
    command: "probe",
    detail: status === "failed" ? "the client did not connect" : "9 tools",
    ms: 1,
  });

  it("settles the client half from a scripted probe that connected", () => {
    expect(clientClaimFrom(probe, endToEnd("verified"), options)).toMatchObject({
      verified: true,
      evidence: "scripted probe",
    });
  });

  it("does not treat a scripted probe that ran and failed as the client half", () => {
    const empty = { ...options, ledger: parseManualRuns(JSON.stringify({ runs: [] })) };
    expect(clientClaimFrom(probe, endToEnd("failed"), empty)).toMatchObject({ verified: false, evidence: "none" });
  });

  it("settles the client half from a person's run recorded on the commit under test", () => {
    expect(clientClaimFrom(probe, undefined, options)).toMatchObject({
      verified: true,
      evidence: "recorded manual run",
    });
  });

  it("leaves the client half unverified when nobody recorded a run on this commit", () => {
    const elsewhere = { ...options, deployedCommit: "0d0c0b0a" };
    const claim = clientClaimFrom(probe, undefined, elsewhere);
    expect(claim).toMatchObject({ verified: false, evidence: "none" });
    expect(claim.detail).toContain("0d0c0b0a");
  });

  it("leaves the client half unverified when the ledger is empty", () => {
    const empty = { ...options, ledger: parseManualRuns(JSON.stringify({ runs: [] })) };
    expect(clientClaimFrom(probe, undefined, empty)).toMatchObject({ verified: false });
  });
});

describe("matrixExitCode", () => {
  const base: MatrixRow = {
    client: "example",
    label: "Example",
    page: "docs/connect/example.md",
    transport: {
      client: "example",
      page: "docs/connect/example.md",
      path: "direct-header",
      status: "verified",
      steps: [],
      ms: 1,
    },
    client_: { verified: false, evidence: "none", detail: "no run recorded on 1a2b3c4d: a graphical client" },
    pass: false,
  };

  it("is 0 while rows are merely awaiting a recorded run", () => {
    expect(matrixExitCode([base])).toBe(0);
  });

  it("is 1 when a transport check failed", () => {
    expect(matrixExitCode([{ ...base, transport: { ...base.transport, status: "failed" } }])).toBe(1);
  });

  it("is 1 when a client probe ran and did not connect", () => {
    expect(
      matrixExitCode([
        { ...base, client_: { verified: false, evidence: "none", detail: "the end-to-end probe failed: no tools" } },
      ]),
    ).toBe(1);
  });

  it("is 0 for an unsupported or not-applicable row, which is not a breakage", () => {
    expect(matrixExitCode([{ ...base, transport: { ...base.transport, status: "unsupported" } }])).toBe(0);
    expect(matrixExitCode([{ ...base, transport: { ...base.transport, status: "not-applicable" } }])).toBe(0);
  });
});
