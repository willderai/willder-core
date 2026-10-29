import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./button";
import { Chip } from "./chip";
import { Modal } from "./modal";
import { Pill } from "./pill";
import { ToastProvider, useToast } from "./toast";

// The shared primitives keep their props and gain what assistive technology
// needs. Modal and the toast stack render outside the product shell's DOM, so
// each portal root must carry the shell attribute that globals.css keys focus
// rings and reduced motion on.

describe("Button", () => {
  it("is the one filled action by default and passes every button prop through", () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" form="invite" className="w-full" onClick={onClick}>
        Send invite
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send invite" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("form")).toBe("invite");
    expect(button.className).toContain("bg-action");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("w-full");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("draws secondary and ghost with a border and no fill at rest", () => {
    render(
      <>
        <Button variant="secondary">Connect</Button>
        <Button variant="ghost">Cancel</Button>
      </>,
    );
    for (const name of ["Connect", "Cancel"]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls).toContain("border-divider");
      expect(cls).not.toMatch(/(^|\s)bg-/);
    }
  });

  it("keeps a disabled button disabled", () => {
    render(<Button disabled>Save</Button>);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Chip and Pill", () => {
  it("set a chip's words in the label face, not mono capitals, on the text roles", () => {
    render(
      <>
        <Chip tone="brick">Could not save the grant.</Chip>
        <Chip>org-wide</Chip>
      </>,
    );
    const error = screen.getByText("Could not save the grant.");
    expect(error.className).toContain("text-danger");
    expect(error.className).not.toMatch(/font-mono|uppercase/);
    expect(screen.getByText("org-wide").className).toContain("text-fg-subtle");
  });

  it("hides a pill's colour dot from assistive technology, since the word carries the state", () => {
    const { container } = render(<Pill dot="brick">revoked</Pill>);
    expect(screen.getByText("revoked")).toBeTruthy();
    const dot = container.querySelector("span > span");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Modal", () => {
  it("is a labelled modal dialog inside a product-shell portal root", () => {
    render(
      <Modal title="Invite a teammate" onClose={() => {}}>
        Body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Invite a teammate" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.closest("[data-product-shell]")).not.toBeNull();
  });

  it("closes on Escape, on the backdrop and on the close button, not on a click inside", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Invite" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    );
    fireEvent.click(screen.getByText("Body"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("type")).toBe("button");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
    const backdrop = screen.getByRole("dialog").previousElementSibling as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  // A page that opens the modal from a button, the way every caller does.
  function Opener({ content }: { content: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Invite</button>
        {open && (
          <Modal title="Invite a teammate" onClose={() => setOpen(false)} footer={<button>Send invite</button>}>
            {content}
          </Modal>
        )}
      </>
    );
  }

  it("moves focus to the first control inside on open and returns it to the opener on close", () => {
    render(<Opener content={<input aria-label="Email" />} />);
    const opener = screen.getByRole("button", { name: "Invite" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Email" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("focuses the close button when the content has no control", () => {
    function Bare() {
      const [open, setOpen] = useState(true);
      return open ? (
        <Modal title="Read me" onClose={() => setOpen(false)}>
          <p>Only words.</p>
        </Modal>
      ) : null;
    }
    render(<Bare />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("wraps Tab and Shift+Tab inside the dialog", () => {
    render(<Opener content={<input aria-label="Email" />} />);
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    const send = screen.getByRole("button", { name: "Send invite" });
    send.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(send);
  });
});

describe("Toast", () => {
  function Fire({ message }: { message: string }) {
    const { toast } = useToast();
    return <button onClick={() => toast(message, "error")}>fire</button>;
  }

  it("announces a toast through a polite live region inside a product-shell portal root", () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Fire message="Could not revoke the token." />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "fire" }));
      const region = screen.getByRole("status");
      expect(region.getAttribute("aria-live")).toBe("polite");
      expect(region.closest("[data-product-shell]")).not.toBeNull();
      expect(region.textContent).toContain("Could not revoke the token.");
      // The stack spans the width on a phone, so only the toasts take clicks.
      expect(region.className).toContain("pointer-events-none");
      const item = region.firstElementChild as HTMLElement;
      expect(item.className).toContain("pointer-events-auto");
      expect(item.className).toMatch(/(^|\s)w-full(\s|$)/);
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(region.textContent).not.toContain("Could not revoke the token.");
    } finally {
      vi.useRealTimers();
    }
  });
});
