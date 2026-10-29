import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OnboardingModal } from "./onboarding-modal";

const ANSWERS = ["We run support agents", "A Next.js app", "Sessions live in Postgres"];

/** Types the three required answers and lands on the last step. */
function answerToLastStep() {
  for (const answer of ANSWERS) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: answer } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onboarding modal", () => {
  it("closes once the server saved the answers it was sent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(<OnboardingModal onDone={onDone} />);
    answerToLastStep();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, string>;
    expect([sent.companyDescription, sent.icp, sent.valueProp]).toEqual(ANSWERS);
  });

  it.each([
    [401, /no workspace yet/],
    [403, /cannot write to this workspace/],
    [500, /were not saved/],
  ])("stays open with the answers kept when the save answers %i", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
    const onDone = vi.fn();
    render(<OnboardingModal onDone={onDone} />);
    answerToLastStep();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(ANSWERS[2]);
  });

  it("stays open when the request never reaches the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const onDone = vi.fn();
    render(<OnboardingModal onDone={onDone} />);
    answerToLastStep();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/were not saved/);
    expect(onDone).not.toHaveBeenCalled();
  });
});
