// GraphitiMemoryStore against a mocked fetch: the camelCase/snake_case mapping at
// the service boundary, the bearer header, and that a failed call surfaces as a
// MemoryServiceError carrying the HTTP status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphitiMemoryStore, MemoryServiceError, retiredAt } from "./graphiti-store";

// Tests the HTTP client mapping (camel<->snake), auth header, and error handling
// against a mocked fetch — no real memory-service needed.
describe("GraphitiMemoryStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ingest maps camelCase -> snake_case and sends the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ episode_id: "ep-1" }) });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.ingest({
      groupId: "org_1",
      content: "Jane is CTO",
      actorType: "human",
      origin: "app",
      actorId: "user_42",
      actorName: "Jane",
    });

    expect(res).toEqual({ episodeId: "ep-1" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/ingest");
    expect(opts.headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(opts.body);
    expect(body.group_id).toBe("org_1");
    expect(body.actor_type).toBe("human");
    expect(body.actor_id).toBe("user_42");
    expect(body.actor_name).toBe("Jane");
  });

  it("posts the graph's reference time from referenceTime only, never a writer's occurredAt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ episode_id: "ep-1", episode_ids: ["ep-2", "ep-3"] }) });
    vi.stubGlobal("fetch", fetchMock);
    const store = new GraphitiMemoryStore("http://svc", "secret");
    const write = {
      groupId: "org_1",
      content: "Price is $5",
      actorType: "agent" as const,
      origin: "mcp" as const,
      actorId: "a1",
    };
    const stated = { occurredAt: "2020-01-01T00:00:00.000Z" };

    await store.ingest({ ...write, ...stated });
    await store.ingest({ ...write, ...stated, referenceTime: "2026-05-01T12:00:00Z" });
    await store.ingestBulk([
      { ...write, ...stated },
      { ...write, ...stated, referenceTime: "2026-05-01T12:00:00Z" },
    ]);

    const [single, withReference, bulk] = fetchMock.mock.calls.map(([, opts]) => JSON.parse(opts.body));
    // No reference time: the memory service uses its own clock.
    expect(single).not.toHaveProperty("reference_time");
    expect(withReference.reference_time).toBe("2026-05-01T12:00:00Z");
    expect(bulk.episodes[0]).not.toHaveProperty("reference_time");
    expect(bulk.episodes[1].reference_time).toBe("2026-05-01T12:00:00Z");
    expect(JSON.stringify([single, withReference, bulk])).not.toContain("2020-01-01");
  });

  it("retrieve maps the snake_case response -> camelCase facts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ facts: [{ uuid: "f1", fact: "x", valid_at: "2026-01-01" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.retrieve({ groupId: "org_1", query: "q", limit: 5 });

    expect(res.facts[0]).toEqual({
      uuid: "f1",
      fact: "x",
      validAt: "2026-01-01",
      store: "graph",
      graphGroupId: "org_1",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.group_id).toBe("org_1");
    expect(body.limit).toBe(5);
  });

  it("sends the stored chunk id with an episode and reads the chunks back on a fact", async () => {
    // Conflict resolution: this round trip is how a graph fact is resolved back
    // to the stored version it belongs to (services/memory/superseded-facts.ts).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        episode_id: "ep-1",
        facts: [
          { uuid: "f1", fact: "x", valid_at: null, chunk_ids: ["chunk_a", "chunk_b"] },
          { uuid: "f2", fact: "y", valid_at: null },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new GraphitiMemoryStore("http://svc", "secret");
    const episode = {
      groupId: "org_1",
      content: "Jane is CTO",
      actorType: "human" as const,
      origin: "app" as const,
      actorId: "user_42",
    };

    await store.ingest({ ...episode, readableId: "chunk_a" });
    await store.ingestBulk([{ ...episode, readableId: "chunk_a" }]);
    const { facts } = await store.retrieve({ groupId: "org_1", query: "q" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chunk_id).toBe("chunk_a");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).episodes[0].chunk_id).toBe("chunk_a");
    expect(facts.map((f) => f.chunkIds)).toEqual([["chunk_a", "chunk_b"], undefined]);
  });

  it("reads the episodes behind a fact, and none from a memory service that predates them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          facts: [
            { uuid: "f1", fact: "x", valid_at: null, episode_ids: ["ep-item"] },
            { uuid: "f2", fact: "y", valid_at: null, episode_ids: [] },
            { uuid: "f3", fact: "z", valid_at: null },
          ],
        }),
      }),
    );
    const { facts } = await new GraphitiMemoryStore("http://svc", "secret").retrieve({ groupId: "org_1", query: "q" });

    expect(facts.map((f) => f.sourceEventIds)).toEqual([["ep-item"], [], undefined]);
  });

  it("throws MemoryServiceError with the status on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "boom",
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    await expect(store.retrieve({ groupId: "o", query: "q" })).rejects.toBeInstanceOf(MemoryServiceError);
  });

  it("throws when the base URL is not configured", async () => {
    const store = new GraphitiMemoryStore("", "");
    await expect(
      store.ingest({ groupId: "o", content: "x", actorType: "human", origin: "app", actorId: "u" }),
    ).rejects.toBeInstanceOf(MemoryServiceError);
  });

  it("removeEpisode() DELETEs /episodes/:id with group_id and maps the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ removed: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.removeEpisode({ groupId: "org_1.slack_general", episodeId: "ep-1" });

    expect(res).toEqual({ removed: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/episodes/ep-1?group_id=org_1-slack_general");
    expect(opts.method).toBe("DELETE");
    expect(opts.headers.authorization).toBe("Bearer secret");
  });

  it("removeEpisode() returns removed:false on 404 instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.removeEpisode({ groupId: "org_1", episodeId: "ep-missing" });
    expect(res).toEqual({ removed: false });
  });

  it("ingest sends sourceId as source_id, omitted (undefined) when not set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ episode_id: "ep-1" }) });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    await store.ingest({
      groupId: "org_1",
      content: "x",
      actorType: "extraction",
      origin: "connector-sync",
      actorId: "slack-sync:src_slack",
      sourceId: "src_slack",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source_id).toBe("src_slack");
  });

  it("removeGroupFacts() DELETEs /groups/:id with no query param when sourceId is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ removed_count: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.removeGroupFacts({ groupId: "org_1.slack_general" });

    expect(res).toEqual({ removedCount: 5 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/groups/org_1-slack_general");
    expect(opts.method).toBe("DELETE");
    expect(opts.headers.authorization).toBe("Bearer secret");
  });

  it("removeGroupFacts() appends ?source_id=... when sourceId is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ removed_count: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.removeGroupFacts({ groupId: "org_1.engineering", sourceId: "src_slack" });

    expect(res).toEqual({ removedCount: 1 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/groups/org_1-engineering?source_id=src_slack");
  });

  it("removeGroupFacts() names a missing route as a stale memory-service deploy", async () => {
    // The route never 404s on an unknown group, so a 404 can only mean the
    // deployed service predates it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '{"detail":"Not Found"}' }),
    );

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const err = await store.removeGroupFacts({ groupId: "org_1.drive", sourceId: "src_1" }).catch((e) => e);

    expect(err).toBeInstanceOf(MemoryServiceError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/no DELETE \/groups endpoint; redeploy/);
  });

  // findFactById answers one question: does this uuid name a fact in this
  // partition? Only two answers are honest — it does, or it demonstrably does
  // not. A service that could not be asked has established neither, so it must
  // throw rather than report the fact absent: the only caller (provenance
  // resolution) would otherwise refuse every write with "fact not found" for as
  // long as the deployment lagged, blaming callers for inventing uuids.
  //
  // Both "cannot be asked" shapes matter. A deployment without the route answers
  // 404 if nothing matches the path, and 405 if something else does — and
  // something else does: DELETE /facts/{uuid} occupies the single-segment path,
  // which is why the lookup hangs off /resolve.
  it("findFactById() throws on a genuine service fault", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "boom",
      }),
    );
    const store = new GraphitiMemoryStore("http://svc", "secret");
    await expect(store.findFactById({ groupId: "org_1", factId: "f1" })).rejects.toThrow(MemoryServiceError);
  });

  it("entity() returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const store = new GraphitiMemoryStore("http://svc", "secret");
    expect(await store.entity({ groupId: "o", entityId: "e" })).toBeNull();
  });

  it("entity() GETs with group_id and maps the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        uuid: "e1",
        name: "Acme",
        type: "Company",
        summary: "a company",
        facts: [{ uuid: "f1", fact: "x", valid_at: null }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new GraphitiMemoryStore("http://svc", "secret");
    const ent = await store.entity({ groupId: "org_1", entityId: "e1" });
    expect(ent).toEqual({
      uuid: "e1",
      name: "Acme",
      type: "Company",
      summary: "a company",
      facts: [{ uuid: "f1", fact: "x", validAt: null }],
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/entities/e1?group_id=org_1");
  });

  it("entity() and graph() read back the chunks behind each fact, as retrieve() does", async () => {
    // Without the stamp the guarded read can match a graph fact to the stored versions
    // only by text, which Graphiti's rewording defeats, so a version that lost a write
    // race would still answer on these two views (services/memory/superseded-facts.ts).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          uuid: "e1",
          name: "Release train",
          type: "Project",
          summary: "",
          facts: [
            { uuid: "f1", fact: "x", valid_at: null, chunk_ids: ["chunk_a"] },
            { uuid: "f2", fact: "y", valid_at: null },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          nodes: [],
          edges: [
            { uuid: "g1", source: "n1", target: "n2", fact: "x", chunk_ids: ["chunk_a", "chunk_b"] },
            { uuid: "g2", source: "n1", target: "n2", fact: "y" },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const store = new GraphitiMemoryStore("http://svc", "secret");

    const entity = await store.entity({ groupId: "org_1", entityId: "e1" });
    const graph = await store.graph({ groupId: "org_1" });

    expect(entity?.facts?.map((f) => f.chunkIds)).toEqual([["chunk_a"], undefined]);
    expect(graph.edges.map((e) => e.chunkIds)).toEqual([["chunk_a", "chunk_b"], undefined]);
  });

  describe("an edge Graphiti itself retired", () => {
    // Graphiti keeps an edge a newer one contradicted and marks it: `invalid_at` is when
    // the fact stopped being true, `expired_at` when the graph recorded that.
    const NOW = Date.parse("2026-10-06T00:00:00Z");
    const facts = [
      { uuid: "current", fact: "a", valid_at: null, invalid_at: null, expired_at: null },
      {
        uuid: "invalidated",
        fact: "b",
        valid_at: null,
        invalid_at: "2026-01-05T00:00:00Z",
        expired_at: "2026-01-06T00:00:00Z",
      },
      { uuid: "expired", fact: "c", valid_at: null, invalid_at: null, expired_at: "2026-01-07T00:00:00Z" },
      { uuid: "true-until-later", fact: "d", valid_at: null, invalid_at: "2027-01-01T00:00:00Z", expired_at: null },
      // How Graphiti actually stores a fact true until a later date: it sets expired_at the
      // moment it records the invalid_at.
      {
        uuid: "ends-later-recorded",
        fact: "f",
        valid_at: null,
        invalid_at: "2027-01-01T00:00:00Z",
        expired_at: "2026-10-05T00:00:00Z",
      },
      { uuid: "older-service", fact: "e", valid_at: null },
    ];
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is left out of retrieve() and entity(), which answer with current facts", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(reply({ facts }))
          .mockResolvedValueOnce(reply({ uuid: "e1", name: "Release train", type: "Project", summary: "", facts })),
      );
      const store = new GraphitiMemoryStore("http://svc", "secret");

      const retrieved = await store.retrieve({ groupId: "org_1", query: "q" });
      const entity = await store.entity({ groupId: "org_1", entityId: "e1" });

      // A fact whose invalid_at is still ahead is true now; one from a service that
      // predates the marks reads as current, as it did before.
      const current = ["current", "true-until-later", "ends-later-recorded", "older-service"];
      expect(retrieved.facts.map((f) => f.uuid)).toEqual(current);
      expect(entity?.facts?.map((f) => f.uuid)).toEqual(current);
    });

    it("is marked in graph(), by when it stopped being true or, without that, when it expired", async () => {
      // The same rule as the answers: a fact true until a date still ahead is current.
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(reply({ nodes: [], edges: facts.map((f) => ({ ...f, source: "n1", target: "n2" })) })),
      );
      const store = new GraphitiMemoryStore("http://svc", "secret");

      const graph = await store.graph({ groupId: "org_1" });

      expect(Object.fromEntries(graph.edges.map((e) => [e.uuid, e.invalidAt]))).toEqual({
        current: null,
        invalidated: "2026-01-05T00:00:00Z",
        expired: "2026-01-07T00:00:00Z",
        "true-until-later": null,
        "ends-later-recorded": null,
        "older-service": null,
      });
    });

    it.each([
      // 05:00 UTC is after NOW: still true. Read as Tokyo time it would be 20:00 UTC the day before.
      ["Asia/Tokyo", "2026-10-06T05:00:00", null],
      // 20:00 UTC the day before is past. Read as Los Angeles time it would be 03:00 UTC, still ahead.
      ["America/Los_Angeles", "2026-10-05T20:00:00", "2026-10-05T20:00:00"],
      // With an offset, as the service sends it, the offset decides.
      ["Asia/Tokyo", "2026-10-05T23:00:00+00:00", "2026-10-05T23:00:00+00:00"],
      ["Asia/Tokyo", "2026-10-06T01:00:00+00:00", null],
      ["Asia/Tokyo", "2026-10-06T10:00:00+05:30", null],
      ["Asia/Tokyo", "2026-10-06T05:00:00.000000000+00:00", null],
      ["America/Los_Angeles", "2026-10-05 20:00:00", "2026-10-05 20:00:00"],
    ])("reads an invalid_at on %s time: %s", (zone, invalidAt, expected) => {
      const before = process.env.TZ;
      process.env.TZ = zone;
      try {
        expect(retiredAt({ invalid_at: invalidAt, expired_at: "2026-10-01T00:00:00Z" })).toBe(expected);
      } finally {
        // Assigning undefined to process.env stores the string "undefined", a zone Node does not know.
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    });

    it("retires a fact at the instant its end date arrives, not one millisecond later", () => {
      const end = "2026-10-06T00:00:00Z";
      expect(retiredAt({ invalid_at: end, expired_at: end }, Date.parse(end))).toBe(end);
      expect(retiredAt({ invalid_at: end, expired_at: end }, Date.parse(end) - 1)).toBeNull();
    });

    it.each([
      [
        "an invalidated edge",
        { invalid_at: "2026-01-05T00:00:00Z", expired_at: "2026-01-06T00:00:00Z" },
        "2026-01-05T00:00:00Z",
      ],
      ["an edge only expired", { invalid_at: null, expired_at: "2026-01-07T00:00:00Z" }, "2026-01-07T00:00:00Z"],
      [
        "an edge true until a later date",
        { invalid_at: "2027-01-01T00:00:00Z", expired_at: "2026-10-05T00:00:00Z" },
        null,
      ],
      ["an edge in force", { invalid_at: null, expired_at: null }, null],
      ["a service that reports invalid_at only", { invalid_at: null }, null],
      ["a service that reports neither", {}, undefined],
      // A mark that cannot be read is not evidence the fact is current: it reads as retired.
      ["an end date that is not a time", { invalid_at: "not a time", expired_at: null }, "not a time"],
    ])("findFactById: %s, by the same rule", async (_label, marks, expected) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ found: true, uuid: "edge-1", fact: "a", ...marks })));
      const store = new GraphitiMemoryStore("http://svc", "secret");

      const res = await store.findFactById({ groupId: "org_1", factId: "edge-1" });

      expect(res?.invalidAt).toBe(expected);
    });
  });

  it("translates a fetch timeout (AbortSignal.timeout) into MemoryServiceError(504)", async () => {
    // AbortSignal.timeout rejects the fetch with a DOMException named "TimeoutError".
    // The store must surface that as a MemoryServiceError(504) — not hang, not leak a
    // raw DOMException — so callers (and the hybrid Promise.allSettled) degrade cleanly.
    const timeoutErr = new DOMException("The operation timed out.", "TimeoutError");
    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const start = Date.now();
    await expect(store.retrieve({ groupId: "o", query: "q" })).rejects.toMatchObject({
      name: "MemoryServiceError",
      status: 504,
    });
    expect(Date.now() - start).toBeLessThan(500);
    // and the fetch was given an AbortSignal (the timeout guard is wired)
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("translates a connection that fails before any response into MemoryServiceError(502), keeping the cause off the message", async () => {
    // undici rejects with a bare TypeError("fetch failed") whose cause names the
    // socket error and the service's internal address.
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:8000"), { code: "ECONNREFUSED" }),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(refused));
    const store = new GraphitiMemoryStore("http://svc", "secret");

    const error = await store.groupResidue({ groupId: "org_1.dept_a" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MemoryServiceError);
    expect(error).toMatchObject({ status: 502, cause: refused });
    expect((error as Error).message).toBe("memory service /groups/residue unreachable");
  });

  it("translates a body that breaks off mid-read into MemoryServiceError(502)", async () => {
    const closed = new TypeError("terminated", { cause: new Error("other side closed") });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(closed) }));
    const store = new GraphitiMemoryStore("http://svc", "secret");

    await expect(store.groupResidue({ groupId: "org_1.dept_a" })).rejects.toMatchObject({
      name: "MemoryServiceError",
      status: 502,
      cause: closed,
    });
  });

  it("translates a timeout that fires while the body is still arriving into MemoryServiceError(504)", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(timeout) }));
    const store = new GraphitiMemoryStore("http://svc", "secret");

    await expect(store.groupResidue({ groupId: "org_1.dept_a" })).rejects.toMatchObject({
      name: "MemoryServiceError",
      status: 504,
    });
  });

  it("removeChunkFacts answers a slow service with MemoryServiceError(504), so a delete never hangs on it", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    const store = new GraphitiMemoryStore("http://svc", "secret");

    await expect(store.removeChunkFacts({ groupId: "org_1", chunkId: "chunk_1" })).rejects.toMatchObject({
      name: "MemoryServiceError",
      status: 504,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("passes a real AbortSignal timeout that fires when the service never responds", async () => {
    // A fetch that only settles when its signal aborts — proves the timeout actually
    // fires and the call doesn't hang. Uses the default (8s) signal but the abort is
    // simulated instantly by rejecting with the signal's reason on abort.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Shorten the timeout for this test by aborting the signal manually via a fake.
    const store = new GraphitiMemoryStore("http://svc", "secret");
    // Kick the abort quickly by monkeypatching AbortSignal.timeout to a short one.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(30));
    const start = Date.now();
    await expect(store.retrieve({ groupId: "o", query: "q" })).rejects.toBeInstanceOf(MemoryServiceError);
    expect(Date.now() - start).toBeLessThan(500);
  });

  // findFactById is the lookup the provenance write path resolves a
  // caller-supplied uuid through. Its two failure answers must stay
  // distinguishable: "this group holds no such fact" is a resolved absence and
  // returns null, while "this service cannot answer" must throw, so a memory
  // service older than the route can never read as a fact that isn't there.
  it("findFactById asks the resolve sub-path, not the one DELETE claims", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ found: true, uuid: "edge-1", fact: "Acme signed the pilot" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.findFactById({ groupId: "org_1.deal_a", factId: "edge-1" });

    expect(res).toEqual({ uuid: "edge-1", fact: "Acme signed the pilot", store: "graph" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/facts/edge-1/resolve?group_id=org_1-deal_a");
    expect(opts.headers.authorization).toBe("Bearer secret");
  });

  it.each([
    ["an invalidated edge carries its invalid_at", { invalid_at: "2026-10-01T09:30:00Z" }, "2026-10-01T09:30:00Z"],
    ["an edge in force carries null", { invalid_at: null }, null],
    ["a service without the field leaves it undefined, not null", {}, undefined],
  ])("findFactById: %s", async (_label, extra, expected) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ found: true, uuid: "edge-1", fact: "Acme signed the pilot", ...extra }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.findFactById({ groupId: "org_1.deal_a", factId: "edge-1" });

    expect(res?.invalidAt).toBe(expected);
  });

  it("findFactById returns null when the service resolves the uuid to no fact", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ found: false }) });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    await expect(store.findFactById({ groupId: "org_1.deal_b", factId: "edge-1" })).resolves.toBeNull();
  });

  it.each([
    [405, "a service where DELETE /facts/{uuid} shadows the path"],
    [404, "a service that does not serve the route at all"],
  ])("findFactById throws rather than answering null on HTTP %i", async (status) => {
    // A memory-service without the /resolve sub-path answers 405 with `allow:
    // DELETE` on the single-segment path. Returning null for either status
    // would let a stale deployment look like a resolved absence and silently
    // refuse every provenance write as "fact not found".
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, statusText: "no", text: async () => "no" });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    await expect(store.findFactById({ groupId: "org_1.deal_a", factId: "edge-1" })).rejects.toMatchObject({
      name: "MemoryServiceError",
      status,
    });
  });

  it("groupResidue() asks for the scope's dashed group id, the key the graph stores", async () => {
    // Graphiti stores a scope under its dashed group id. Sent the dotted path,
    // the service would count an empty group and the scope would delete.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ facts: 3, episodes: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.groupResidue({ groupId: "org_1.dept_a" });

    expect(res).toEqual({ facts: 3, episodes: 1 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/groups/residue");
    expect(opts.method).toBe("POST");
    expect(opts.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(opts.body)).toEqual({ group_id: "org_1-dept_a" });
  });

  it("listUnstampedFileEpisodes() and stampEpisodeChunk() send the dashed group id and read the service's answers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          episodes: [{ uuid: "ep-1", content_digest: "ab", file_name_digest: "cd", pending_retirement: false }],
          scanned: 4,
          next_after: "ep-4",
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ outcome: "stamped" }) });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const page = await store.listUnstampedFileEpisodes({ groupId: "org_1.dept_a", salt: "s".repeat(32), limit: 50 });
    const outcome = await store.stampEpisodeChunk({ groupId: "org_1.dept_a", episodeUuid: "ep-1", chunkId: "chunk-1" });

    expect(page).toEqual({
      episodes: [{ uuid: "ep-1", contentDigest: "ab", fileNameDigest: "cd", pendingRetirement: false }],
      scanned: 4,
      nextAfter: "ep-4",
    });
    expect(outcome).toBe("stamped");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://svc/episodes/unstamped-files",
      "http://svc/episodes/stamp-chunk",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      group_id: "org_1-dept_a",
      salt: "s".repeat(32),
      after: null,
      limit: 50,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      group_id: "org_1-dept_a",
      episode_uuid: "ep-1",
      chunk_id: "chunk-1",
    });
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer secret");
  });

  it("sourceRecords() asks for the dashed group ids the graph stores scopes under", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        groups: [
          {
            group_id: "acme",
            episodes: 1,
            facts: 0,
            fact_embeddings: 0,
            verbatim_nodes: 0,
            orphans: 0,
            dangling_facts: 0,
          },
          {
            group_id: "org_acme-dept_a-team_b",
            episodes: 2,
            facts: 3,
            fact_embeddings: 3,
            verbatim_nodes: 1,
            orphans: 4,
            dangling_facts: 5,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = new GraphitiMemoryStore("http://svc", "secret");
    const res = await store.sourceRecords({ orgId: "acme", sourceId: "src_1", scopePaths: ["org_acme.dept_a.team_b"] });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://svc/sources/records");
    expect(JSON.parse(opts.body)).toEqual({
      org_id: "acme",
      source_id: "src_1",
      group_ids: ["org_acme-dept_a-team_b"],
    });
    expect(res).toEqual([
      { groupId: "acme", episodes: 1, facts: 0, factEmbeddings: 0, verbatimNodes: 0, orphans: 0, danglingFacts: 0 },
      {
        groupId: "org_acme-dept_a-team_b",
        episodes: 2,
        facts: 3,
        factEmbeddings: 3,
        verbatimNodes: 1,
        orphans: 4,
        danglingFacts: 5,
      },
    ]);
  });

  it("sourceRecords() names the fix when the deployed memory service predates the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => '{"detail":"Not Found"}',
      }),
    );

    const store = new GraphitiMemoryStore("http://svc", "secret");

    await expect(
      store.sourceRecords({ orgId: "acme", sourceId: "src_1", scopePaths: ["org_acme"] }),
    ).rejects.toMatchObject({
      name: "MemoryServiceError",
      status: 404,
      message: "The memory service has no POST /sources/records endpoint; redeploy it from this repo's memory-service.",
    });
  });

  describe("removeFact() and untagged facts", () => {
    // Ingest without a scopePath (the Clerk webhook, contacts, accounts, org roles,
    // enrichment) stores a fact under the bare org id's Graphiti group. An org-root
    // reader sees it through retrieve()'s bare-org leg, so an org-root delete must
    // reach it too, the way pgvector-store.ts lets an org-root delete reach a row
    // with no scopePath. A narrower delete must not.
    const notFound = { ok: false, status: 404, statusText: "Not Found", text: async () => "fact not found" };
    const removed = { ok: true, status: 200, json: async () => ({ removed: true }) };
    const groupsAsked = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get("group_id"));

    it("an org-root delete that misses the org-root group removes the fact from the bare-org group", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(notFound).mockResolvedValueOnce(removed);
      vi.stubGlobal("fetch", fetchMock);

      const store = new GraphitiMemoryStore("http://svc", "secret");
      const res = await store.removeFact({ groupId: "org_acme", tenantId: "acme", factId: "edge-1" });

      expect(res).toEqual({ removed: true });
      expect(groupsAsked(fetchMock)).toEqual(["org_acme", "acme"]);
      expect(fetchMock.mock.calls[1][0]).toBe("http://svc/facts/edge-1?group_id=acme");
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
    });

    it("an org-root delete found in the org-root group does not touch the bare-org group", async () => {
      const fetchMock = vi.fn().mockResolvedValue(removed);
      vi.stubGlobal("fetch", fetchMock);

      const store = new GraphitiMemoryStore("http://svc", "secret");
      const res = await store.removeFact({ groupId: "org_acme", tenantId: "acme", factId: "edge-1" });

      expect(res).toEqual({ removed: true });
      expect(groupsAsked(fetchMock)).toEqual(["org_acme"]);
    });

    it("a delete authorized below org root never reaches the bare-org group", async () => {
      const fetchMock = vi.fn().mockResolvedValue(notFound);
      vi.stubGlobal("fetch", fetchMock);

      const store = new GraphitiMemoryStore("http://svc", "secret");
      const res = await store.removeFact({ groupId: "org_acme.deal_a", tenantId: "acme", factId: "edge-1" });

      expect(res).toEqual({ removed: false });
      expect(groupsAsked(fetchMock)).toEqual(["org_acme-deal_a"]);
    });

    it("a delete with no tenant id stays in the group it was given", async () => {
      const fetchMock = vi.fn().mockResolvedValue(notFound);
      vi.stubGlobal("fetch", fetchMock);

      const store = new GraphitiMemoryStore("http://svc", "secret");
      const res = await store.removeFact({ groupId: "org_acme", factId: "edge-1" });

      expect(res).toEqual({ removed: false });
      expect(groupsAsked(fetchMock)).toEqual(["org_acme"]);
    });

    it("a failed org-root delete is reported, not retried in the bare-org group", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503, statusText: "down", text: async () => "down" });
      vi.stubGlobal("fetch", fetchMock);

      const store = new GraphitiMemoryStore("http://svc", "secret");
      await expect(store.removeFact({ groupId: "org_acme", tenantId: "acme", factId: "edge-1" })).rejects.toMatchObject(
        { name: "MemoryServiceError", status: 503 },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("GraphitiMemoryStore over several partitions in one call", () => {
  const respond = (status: number, body: unknown) =>
    vi
      .fn()
      .mockResolvedValue({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const store = () => new GraphitiMemoryStore("http://svc", "secret");
  const fact = { uuid: "f1", fact: "Renewal is March 3", valid_at: null, group_id: "org_x-eng-t59" };

  it.each([
    { name: "every partition", groupsSearched: 3, ok: true },
    { name: "fewer partitions than asked", groupsSearched: 1, ok: false },
    { name: "no count, from a service older than group_ids", groupsSearched: undefined, ok: false },
  ])("search answering for $name", async ({ groupsSearched, ok }) => {
    const fetchMock = respond(200, {
      facts: [fact],
      ...(groupsSearched === undefined ? {} : { groups_searched: groupsSearched }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const read = store().retrieve({
      groupId: "org_x.eng.t00",
      groupIds: ["org_x.eng.t01", "org_x.eng.t59"],
      query: "renewal",
    });

    if (ok) await expect(read).resolves.toMatchObject({ facts: [{ uuid: "f1", graphGroupId: "org_x-eng-t59" }] });
    else await expect(read).rejects.toThrow(/partitions/);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ group_id: "org_x-eng-t00", group_ids: ["org_x-eng-t01", "org_x-eng-t59"] });
  });

  it.each([
    {
      name: "a hit",
      status: 200,
      body: { entity: { uuid: "e1", name: "Dana", type: "Person", summary: "", facts: [] }, group_id: "org_x-eng" },
      outcome: "Dana",
    },
    { name: "a miss", status: 200, body: { entity: null, group_id: null }, outcome: null },
    { name: "a service without the route", status: 404, body: { detail: "Not Found" }, outcome: "error" },
  ])("entity lookup over partitions answering $name", async ({ status, body, outcome }) => {
    vi.stubGlobal("fetch", respond(status, body));

    const lookup = store().entity({ groupId: "org_x", entityId: "e1", groupIds: ["org_x.eng"] });

    if (outcome === "error") await expect(lookup).rejects.toMatchObject({ name: "MemoryServiceError", status: 404 });
    else if (outcome === null) await expect(lookup).resolves.toBeNull();
    else await expect(lookup).resolves.toMatchObject({ name: outcome, graphGroupId: "org_x-eng" });
  });

  it("a one-partition search names its partition even when the service does not", async () => {
    vi.stubGlobal("fetch", respond(200, { facts: [{ uuid: "f1", fact: "x", valid_at: null }] }));

    const { facts } = await store().retrieve({ groupId: "org_x.eng", query: "q" });

    expect(facts[0].graphGroupId).toBe("org_x-eng");
  });

  it("names the scopes holding an entity in the order asked, and only scopes it asked", async () => {
    const fetchMock = respond(200, { group_ids: ["org_x-eng", "org_x-unasked", "org_x"] });
    vi.stubGlobal("fetch", fetchMock);

    const groups = await store().groupsHoldingEntity({ name: "Dana", groupIds: ["org_x", "org_x.eng"] });

    expect(groups).toEqual(["org_x", "org_x.eng"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Dana", group_ids: ["org_x", "org_x-eng"] });
  });
});
