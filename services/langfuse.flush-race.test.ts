import { afterEach, describe, expect, it, vi } from "vitest";
import Langfuse from "langfuse";

// ---------------------------------------------------------------------------
// Independent proof of the flush claim, against the REAL langfuse SDK.
//
// services/langfuse.test.ts's regression guard asserts that flushAgentTrace()
// calls shutdownAsync() rather than flushAsync(). That guard is necessary but
// it is true-by-construction: it would still pass if the two SDK methods were
// behaviourally identical, i.e. if the whole reason for the switch were wrong.
//
// These tests close that gap by exercising the real `Langfuse` client (no SDK
// mock — only global fetch is stubbed, so the SDK's own queue/flush/ingestion
// machinery runs for real) and observing whether the in-flight ingestion HTTP
// request has actually landed by the time each method resolves:
//
//   flushAsync()    resolves with ingestion requests STILL IN FLIGHT
//   shutdownAsync() resolves only AFTER they have all completed
//
// That difference is the entire production claim: on a Vercel function frozen
// right after the response is sent, anything still in flight is silently lost,
// and an already-wired path reports zero traces.
// ---------------------------------------------------------------------------

type FetchTracker = {
  started: number;
  completed: number;
  releaseAll: () => void;
};

/** Stub global fetch with an ingestion endpoint whose response we control. */
function stubIngestionFetch(opts: { autoReleaseAfterMs?: number } = {}): FetchTracker {
  const pending: Array<() => void> = [];
  const tracker: FetchTracker = {
    started: 0,
    completed: 0,
    releaseAll: () => {
      while (pending.length) pending.shift()!();
    },
  };

  vi.stubGlobal("fetch", () => {
    tracker.started += 1;
    return new Promise((resolve) => {
      const finish = () => {
        tracker.completed += 1;
        resolve({ status: 200, json: async () => ({}) } as unknown as Response);
      };
      if (opts.autoReleaseAfterMs !== undefined) setTimeout(finish, opts.autoReleaseAfterMs);
      else pending.push(finish);
    });
  });

  return tracker;
}

function newClient(): Langfuse {
  return new Langfuse({
    publicKey: "pk_test",
    secretKey: "sk_test",
    baseUrl: "https://langfuse.test",
    // Same config as services/langfuse.ts — flushAt:1 is what makes every single
    // event trigger its own eager background flush, which is the precondition
    // for the race below.
    flushAt: 1,
  });
}

/** Emit one trace + one generation, the exact shape every agent role produces. */
function emitOneAgentRun(lf: Langfuse): void {
  const trace = lf.trace({ name: "research-agent-run", userId: "org_1", tags: ["research-agent"] });
  const generation = trace.generation({ name: "research-agent-generate", model: "gpt-4o-mini", input: {} });
  void generation.end({ output: { text: "found signals" }, level: "DEFAULT" });
}

describe("langfuse SDK: flushAsync vs shutdownAsync, the production claim", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flushAsync() resolves while ingestion requests are still in flight — the trace is NOT durably delivered", async () => {
    const fetches = stubIngestionFetch();
    const lf = newClient();
    emitOneAgentRun(lf);

    await lf.flushAsync();

    // The real defect: flushAsync() reported success, but the HTTP request(s)
    // carrying the events have not completed. Anything that kills the process
    // here (a frozen serverless function) loses them silently.
    expect(fetches.started).toBeGreaterThan(0);
    expect(fetches.completed).toBe(0);

    fetches.releaseAll();
    await lf.shutdownAsync();
  });

  it("shutdownAsync() resolves only after every in-flight ingestion request has completed", async () => {
    const fetches = stubIngestionFetch({ autoReleaseAfterMs: 40 });
    const lf = newClient();
    emitOneAgentRun(lf);

    await lf.shutdownAsync();

    expect(fetches.started).toBeGreaterThan(0);
    expect(fetches.completed).toBe(fetches.started);
  });

  it("the client still delivers traces after a previous shutdownAsync() — safe to reuse the cached singleton", async () => {
    // services/langfuse.ts caches one client in a module-level singleton and calls
    // flushAgentTrace() (=> shutdownAsync()) at the end of EVERY agent run, so a
    // second run on the same warm instance must still be delivered. Verified here
    // rather than assumed: shutdownAsync() sets no "closed" flag, it only clears
    // the flush timer, which flush() re-arms on the next enqueue.
    const fetches = stubIngestionFetch({ autoReleaseAfterMs: 10 });
    const lf = newClient();

    emitOneAgentRun(lf);
    await lf.shutdownAsync();
    const afterFirst = fetches.completed;
    expect(afterFirst).toBeGreaterThan(0);

    emitOneAgentRun(lf);
    await lf.shutdownAsync();

    expect(fetches.completed).toBeGreaterThan(afterFirst);
    expect(fetches.completed).toBe(fetches.started);
  });
});
