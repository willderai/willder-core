// The person-erasure job's own rules (lib/inngest/person-erasure.ts), which the request
// store's realdb suite cannot reach: what the queue receives, what a failed attempt leaves in
// Inngest's history, and that a run ending without success marks its request failed rather
// than leaving it running forever. No database or Inngest server: the store and the client
// are fakes.
import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryServiceError } from "@/services/memory/graphiti-store";

const run = vi.fn();
const fail = vi.fn();
const sweep = vi.fn();
vi.mock("@/services/memory/person-erasure-requests", () => ({
  runPersonErasureRequest: (...a: unknown[]) => run(...a),
  failPersonErasureRequest: (...a: unknown[]) => fail(...a),
  sweepStuckPersonErasures: (...a: unknown[]) => sweep(...a),
}));
const send = vi.fn();
vi.mock("./client", async (actual) => {
  const real = await actual<typeof import("./client")>();
  real.inngest.send = ((...a: unknown[]) => send(...a)) as typeof real.inngest.send;
  return real;
});

const { personErasure, personErasureSweep, queuePersonErasure, requeuePersonErasure } = await import(
  "./person-erasure"
);
const ID = "6f1c2a9e-0b7d-4e8a-9c3f-2d5e8a1b4c70";
const PERSON = "rhea.okafor@acme.example";
type Handler = (ctx: unknown) => Promise<unknown>;
const handler = (personErasure as unknown as { fn: Handler }).fn;
const onFailure = personErasure.opts.onFailure as unknown as Handler;
const step = { run: (_id: string, cb: () => unknown) => cb() };
const attempt = () => handler({ event: { data: { requestId: ID } }, step });

beforeEach(() => {
  run.mockReset();
  fail.mockReset();
  sweep.mockReset();
  send.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("person-erasure job", () => {
  it.each([
    ["the request", queuePersonErasure, `person-erasure-${ID}`],
    ["the sweep's retry, apart from the first event", requeuePersonErasure, `person-erasure-${ID}-retry`],
  ])(
    "queues the request id alone for %s, under an event id that makes a resend a no-op",
    async (_name, queue, eventId) => {
      await queue(ID);
      expect(send).toHaveBeenCalledWith({ id: eventId, name: "person/erasure.requested", data: { requestId: ID } });
    },
  );

  it("the sweep runs on a schedule and queues its retries under the retry event id", async () => {
    sweep.mockImplementation(async (requeue: (id: string) => Promise<void>) => requeue(ID));
    await (personErasureSweep as unknown as { fn: Handler }).fn({ step });
    expect(personErasureSweep.opts.triggers).toEqual([{ cron: "*/10 * * * *" }]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: `person-erasure-${ID}-retry` }));
  });

  it.each([
    [
      "a store error is retried, and its text stays out of the run's history",
      new Error(`could not delete ${PERSON}`),
      Error,
      null,
    ],
    [
      "a graph link out of the org fails the request for an operator, with no retry",
      new MemoryServiceError(`edge to ${PERSON}`, 409),
      NonRetriableError,
      /operator/,
    ],
  ])("%s", async (_name, thrown, kind, failedWith) => {
    run.mockRejectedValueOnce(thrown);
    const error = await attempt().then(
      () => null,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(kind);
    expect(error!.message).not.toContain(PERSON);
    if (failedWith) expect(fail).toHaveBeenCalledWith(ID, expect.stringMatching(failedWith));
    else expect(fail).not.toHaveBeenCalled();
  });

  it("marks the request failed once its retries run out, so it is never left running", async () => {
    await onFailure({ event: { data: { event: { data: { requestId: ID } } } }, error: new Error("attempt failed") });
    expect(fail).toHaveBeenCalledWith(ID, expect.stringMatching(/again/));
  });
});
