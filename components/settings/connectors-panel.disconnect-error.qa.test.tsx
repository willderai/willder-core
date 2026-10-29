// @vitest-environment jsdom
//
// A failed disconnect in the Slack/Figma connectors panel must show a readable
// reason. The DELETE route can answer with a JSON error body (502/500) or, from
// an older deploy or a proxy, with no body at all; parsing an empty body used
// to surface the JSON parser's own message instead of the HTTP status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { answerSources } from "./sources-test-api";

const slackSource = {
  id: "src_2",
  type: "slack",
  externalId: "C1",
  name: "#general",
  scopePath: "org.eng",
  status: "active",
  createdAt: "2026-10-01T00:00:00Z",
};

function mockDisconnectFailure(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? response : answerSources([slackSource])(url, init),
    ),
  );
}

async function clickDisconnect() {
  const { ConnectorsPanel } = await import("./connectors-panel");
  render(<ConnectorsPanel />);
  fireEvent.click(await screen.findByText("Disconnect"));
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ConnectorsPanel — failed disconnect", () => {
  it("never quotes a 5xx's text, which can carry a downstream service's error from a JSON error body", async () => {
    mockDisconnectFailure(
      new Response(
        JSON.stringify({ error: "Could not remove this source's facts from memory, so it is still connected." }),
        {
          status: 502,
        },
      ),
    );
    await clickDisconnect();
    expect(
      await screen.findByText(
        "Willder could not remove this source's content from memory (HTTP 502), so it is still connected. Try again in a minute.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("#general")).toBeTruthy();
  });

  it("names the HTTP status when the error response has no body", async () => {
    mockDisconnectFailure(new Response(null, { status: 500 }));
    await clickDisconnect();
    expect(
      await screen.findByText(
        "Willder could not remove this source's content from memory (HTTP 500), so it is still connected. Try again in a minute.",
      ),
    ).toBeTruthy();
  });
});
