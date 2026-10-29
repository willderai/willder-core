import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const auth = vi.hoisted(() => ({ orgId: null as string | null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ orgId: auth.orgId }) }));

import { OnboardingGate } from "./onboarding-gate";

const DIALOG_TITLE = "Set up your workspace";

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Lets the gate's fetch and JSON parse settle before asserting the modal stayed closed. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  vi.unstubAllGlobals();
  auth.orgId = null;
});

describe("onboarding gate", () => {
  it("does not ask before the user has a workspace to save the answers in", async () => {
    const fetchMock = respond(200, { done: false });
    render(<OnboardingGate />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(DIALOG_TITLE)).toBeNull();
  });

  it("opens for a workspace whose onboarding is not done", async () => {
    auth.orgId = "org_1";
    respond(200, { done: false });
    render(<OnboardingGate />);
    expect(await screen.findByText(DIALOG_TITLE)).toBeTruthy();
  });

  it.each([
    ["the session has no workspace (401)", 401, { error: "unauthorized" }],
    ["the server fails", 500, { error: "boom" }],
    ["onboarding is done", 200, { done: true }],
    ["the body has no done flag", 200, {}],
  ])("stays closed when %s", async (_case, status, body) => {
    auth.orgId = "org_1";
    respond(status, body);
    render(<OnboardingGate />);
    await settle();
    expect(screen.queryByText(DIALOG_TITLE)).toBeNull();
  });

  it("checks again once a workspace exists", async () => {
    const fetchMock = respond(200, { done: false });
    const { rerender } = render(<OnboardingGate />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    auth.orgId = "org_new";
    rerender(<OnboardingGate />);
    expect(await screen.findByText(DIALOG_TITLE)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("closes when the user switches to a workspace that is already set up", async () => {
    auth.orgId = "org_1";
    respond(200, { done: false });
    const { rerender } = render(<OnboardingGate />);
    await screen.findByText(DIALOG_TITLE);

    auth.orgId = "org_2";
    respond(200, { done: true });
    rerender(<OnboardingGate />);
    await waitFor(() => expect(screen.queryByText(DIALOG_TITLE)).toBeNull());
  });
});
