// @vitest-environment jsdom
//
// A successful password sign-in must land on /dashboard. The sign-in page and the
// product shell sit under different layouts, each with its own ClerkProvider, so a
// client-side push from inside Clerk's finalize() swaps providers while setActive is
// still running and the browser stays on /sign-in. The form leaves with a full page
// load instead. Clerk's hook is faked; finalize() calls the navigate callback the way
// Clerk does once the session is set.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignInForm } from "./sign-in-form";

type SignInStatus = "complete" | "needs_second_factor" | "needs_client_trust";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

let signIn: {
  status: SignInStatus;
  password: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  sso: ReturnType<typeof vi.fn>;
};
vi.mock("@clerk/nextjs", () => ({
  useSignIn: () => ({ signIn, errors: null, fetchStatus: "idle" }),
}));

let assign: ReturnType<typeof vi.fn>;

function fakeSignIn(statusAfterPassword: SignInStatus, error: unknown = null) {
  signIn = {
    status: "needs_first_factor" as SignInStatus,
    password: vi.fn(async () => {
      signIn.status = statusAfterPassword;
      return { error };
    }),
    finalize: vi.fn(async ({ navigate }) => {
      await navigate({ session: { id: "sess_1" }, decorateUrl: (url: string) => url });
      return { error: null };
    }),
    sso: vi.fn(),
  };
}

function submit() {
  render(<SignInForm />);
  fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "dev@acme.test" } });
  fireEvent.change(screen.getByPlaceholderText("Enter your password"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  push.mockReset();
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "http://localhost:3000/sign-in", origin: "http://localhost:3000", assign },
  });
});

afterEach(() => {
  cleanup();
});

describe("SignInForm", () => {
  it("loads /dashboard as a full page once the password sign-in completes", async () => {
    fakeSignIn("complete");
    submit();

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard"));
    expect(signIn.password).toHaveBeenCalledWith({ identifier: "dev@acme.test", password: "correct horse" });
    expect(push).not.toHaveBeenCalled();
  });

  it("follows Clerk's decorated absolute URL as a full page load too", async () => {
    fakeSignIn("complete");
    signIn.finalize.mockImplementation(async ({ navigate }) => {
      await navigate({
        session: { id: "sess_1" },
        decorateUrl: () => "https://clerk.willder.test/v1/client/touch?redirect_url=%2Fdashboard",
      });
      return { error: null };
    });
    submit();

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://clerk.willder.test/v1/client/touch?redirect_url=%2Fdashboard"),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("says so when Clerk asks for a step this form cannot complete, instead of sitting on the page", async () => {
    fakeSignIn("needs_client_trust");
    submit();

    expect(await screen.findByText(/needs another verification step/i)).toBeTruthy();
    expect(signIn.finalize).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("clears that message when the next attempt is rejected, so it never sits beside a different error", async () => {
    fakeSignIn("needs_client_trust");
    submit();
    expect(await screen.findByText(/needs another verification step/i)).toBeTruthy();

    signIn.password.mockResolvedValueOnce({ error: { message: "Password is incorrect" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.queryByText(/needs another verification step/i)).toBeNull());
    expect(signIn.password).toHaveBeenCalledTimes(2);
  });

  it("stays on the page without navigating when the password is rejected", async () => {
    fakeSignIn("needs_second_factor", { message: "Password is incorrect" });
    submit();

    await waitFor(() => expect(signIn.password).toHaveBeenCalled());
    expect(signIn.finalize).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByText(/needs another verification step/i)).toBeNull();
  });
});
