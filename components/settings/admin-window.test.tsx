// The admin window card: an agent token holding `admin` is shown with the time left
// until the server closes it, the countdown moves with the clock, and revoke reaches
// the token it sits next to. Nothing shows when no agent holds admin.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AdminWindowCard, timeLeft } from "./admin-window";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();
const SECOND = 1000;
const HOUR = 3600 * SECOND;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("timeLeft", () => {
  it("counts down to the window's end and reads closing once it has passed", () => {
    expect(timeLeft(at(2 * HOUR), NOW)).toBe("2h 00m 00s");
    expect(timeLeft(at(2 * HOUR - SECOND), NOW)).toBe("1h 59m 59s");
    expect(timeLeft(at(59 * SECOND), NOW)).toBe("00m 59s");
    expect(timeLeft(at(0), NOW)).toBe("closing");
    expect(timeLeft(at(-SECOND), NOW)).toBe("closing");
  });
});

describe("AdminWindowCard", () => {
  it("shows each open window ticking down, and revokes the one asked for", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const onRevoke = vi.fn();
    render(
      <AdminWindowCard
        tokens={[
          { id: "cap_a", agentId: "setup-agent", scopePath: "org_1", expiresAt: at(2 * HOUR) },
          { id: "cap_b", agentId: "other-agent", scopePath: "org_1.eng", expiresAt: at(10 * SECOND) },
        ]}
        onRevoke={onRevoke}
      />,
    );
    expect(screen.getByText("2h 00m 00s left")).toBeTruthy();
    expect(screen.getByText("00m 10s left")).toBeTruthy();

    act(() => vi.advanceTimersByTime(3 * SECOND));
    expect(screen.getByText("1h 59m 57s left")).toBeTruthy();
    expect(screen.getByText("00m 07s left")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "revoke" })[1]);
    expect(onRevoke).toHaveBeenCalledWith("cap_b");
  });

  it("renders nothing when no agent holds admin", () => {
    const { container } = render(<AdminWindowCard tokens={[]} onRevoke={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
