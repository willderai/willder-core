// @vitest-environment jsdom
//
// Regression for the production connect path, which the panel must be able
// to complete.
//
// ConnectorsPanel's Slack and Figma connect forms must include a `token`
// field, not just post `{ type, channelId, channelName }` / `{ type,
// fileKey, fileName }` with no field that could supply one: app/api/sources/
// route.ts rejects a tokenless slack/figma connect with 400 whenever fixture
// mode is off, and services/connectors/{slack,figma}.ts force *_MOCK to false
// when VERCEL_ENV === "production", so without a token field every Connect
// attempt in production fails with no way for the user to fix it.
//
// The PostHog branch of this same form asks for the API key up front; Slack
// and Figma need the same token field.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Records the POST /api/sources body the panel actually sends. */
function captureConnectBody(): { get: () => Record<string, unknown> | undefined } {
  let posted: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (isSourcesList(url) && method === "GET") return Response.json(sourcesPage(url, []));
      if (url === "/api/sources" && method === "POST") {
        posted = JSON.parse(init!.body as string);
        // Mirrors app/api/sources/route.ts with SLACK_MOCK/FIGMA_MOCK false.
        if (!posted!.token) {
          return new Response(JSON.stringify({ error: `token is required for ${posted!.type} outside fixture mode` }), {
            status: 400,
          });
        }
        return new Response(JSON.stringify({ source: {}, jobId: "job_1" }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { get: () => posted };
}

describe("ConnectorsPanel — production connect contract", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "production");
  });

  it("production forces fixture mode off, so /api/sources demands a token", async () => {
    const { SLACK_MOCK } = await import("@/services/connectors/slack");
    const { FIGMA_MOCK } = await import("@/services/connectors/figma");
    expect(SLACK_MOCK).toBe(false);
    expect(FIGMA_MOCK).toBe(false);
  });

  it("sends a token when connecting a Slack channel", async () => {
    const captured = captureConnectBody();
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C123" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#eng" } });
    const tokenInput = screen.getByPlaceholderText(/Bot token/);
    expect(tokenInput.getAttribute("type")).toBe("password");
    fireEvent.change(tokenInput, { target: { value: "xoxb-test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(captured.get()).toBeDefined());
    expect(captured.get()).toHaveProperty("token", "xoxb-test-token");
  });

  it("sends a token when connecting a Figma file", async () => {
    const captured = captureConnectBody();
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect Figma" }));
    fireEvent.change(screen.getByPlaceholderText(/File key/), { target: { value: "F123" } });
    fireEvent.change(screen.getByPlaceholderText(/File name/), { target: { value: "Design System" } });
    const tokenInput = screen.getByPlaceholderText(/Personal access token/);
    expect(tokenInput.getAttribute("type")).toBe("password");
    fireEvent.change(tokenInput, { target: { value: "figd-test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(captured.get()).toBeDefined());
    expect(captured.get()).toHaveProperty("token", "figd-test-token");
  });

  it("surfaces the tokenless 400 to the user when the token field is left blank", async () => {
    captureConnectBody();
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await waitFor(() => expect(screen.getByText(/No Slack, Figma, PostHog or GitHub sources/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "+ Connect Slack" }));
    fireEvent.change(screen.getByPlaceholderText(/Channel ID/), { target: { value: "C123" } });
    fireEvent.change(screen.getByPlaceholderText(/Channel name/), { target: { value: "#eng" } });
    // Token field exists but is deliberately left empty here — the button no
    // longer requires it (dev/fixture mode never needs one), so this still
    // documents the real production consequence of connecting without one.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByText(/token is required for slack outside fixture mode/)).toBeTruthy());
  });
});
