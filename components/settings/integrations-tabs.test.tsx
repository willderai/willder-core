// @vitest-environment jsdom
//
// The Integrations tabs: the anchor chooses the tab, so old links, back and forward
// and a shared link all open the right panel; a URL without one gets the tab its query
// implies written in; only the open panel mounts; and the row works as ARIA tabs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntegrationsTabs, integrationsTabFor, type IntegrationsTab } from "./integrations-tabs";

const TABS: IntegrationsTab[] = [
  { id: "sources", label: "Knowledge sources", panel: <p>sources panel</p> },
  { id: "connectors", label: "Connectors", panel: <p>connectors panel</p> },
  { id: "mailboxes", label: "Mailboxes", panel: <p>mailbox panel</p> },
  { id: "connect-ai", label: "Connect your AI", panel: <p>mcp panel</p> },
  { id: "connected-apps", label: "Connected apps", panel: <p>apps panel</p> },
];

beforeEach(() => window.history.replaceState(null, "", "/integrations"));
afterEach(cleanup);

const panelText = () => screen.getByRole("tabpanel").textContent;
const tab = (name: string) => screen.getByRole("tab", { name });

/** Steps back one history entry and waits for the popstate jsdom fires for it. */
async function back() {
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await popped;
  });
}

describe("integrationsTabFor", () => {
  it.each([
    ["", "#mailboxes", "mailboxes"],
    ["", "#connect-ai", "connect-ai"],
    ["", "#source-cmabc123", "sources"],
    ["", "#source-a%20b", "sources"],
    // A malformed escape is matched as written rather than throwing.
    ["", "#mailboxes%E0%A4%A", "sources"],
    ["?integration=gmail&connected=1", "", "mailboxes"],
    ["?integration=outlook&connected=0", "", "mailboxes"],
    ["?integration=slack&connected=1", "", "connectors"],
    ["?connections.q=claude", "", "connect-ai"],
    ["?disconnected.sort=name", "", "connect-ai"],
    ["?apps.q=cursor", "", "connected-apps"],
    ["?connectors.status=error", "", "connectors"],
    ["?sources.page=2", "", "sources"],
    ["?mailboxes.gmail.page=2", "", "mailboxes"],
    // The anchor decides over the query.
    ["?connections.q=claude", "#mailboxes", "mailboxes"],
    ["", "", "sources"],
    ["", "#nothing-here", "sources"],
    ["?unrelated=1", "", "sources"],
  ])("opens %s%s on %s", (search, hash, expected) => {
    expect(integrationsTabFor(TABS, search, hash)).toBe(expected);
  });

  it("follows an alias to the tab that covers it, and falls back to the first tab without one", () => {
    const withoutConnectors = [{ id: "sources", aliases: ["connectors"] }, { id: "mailboxes" }];
    expect(integrationsTabFor(withoutConnectors, "", "#connectors")).toBe("sources");
    expect(integrationsTabFor(withoutConnectors, "?integration=slack", "")).toBe("sources");
    expect(integrationsTabFor([{ id: "mailboxes" }, { id: "connect-ai" }], "", "#connected-apps")).toBe("mailboxes");
  });
});

describe("IntegrationsTabs", () => {
  it("marks the open tab, names its panel by it, and mounts no other panel", () => {
    window.history.replaceState(null, "", "/integrations#connect-ai");
    render(<IntegrationsTabs tabs={TABS} />);
    expect(panelText()).toBe("mcp panel");
    expect(screen.queryByText("sources panel")).toBeNull();
    const open = tab("Connect your AI");
    expect(open.getAttribute("aria-selected")).toBe("true");
    expect(open.tabIndex).toBe(0);
    expect(open.getAttribute("aria-controls")).toBe("tabpanel-connect-ai");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(open.id);
    for (const other of ["Knowledge sources", "Connectors", "Mailboxes", "Connected apps"]) {
      expect(tab(other).getAttribute("aria-selected")).toBe("false");
      expect(tab(other).tabIndex).toBe(-1);
    }
  });

  it("writes the first tab into a URL with no anchor, keeping its query", () => {
    window.history.replaceState(null, "", "/integrations?sources.q=deck");
    render(<IntegrationsTabs tabs={TABS} />);
    expect(panelText()).toBe("sources panel");
    expect(`${window.location.search}${window.location.hash}`).toBe("?sources.q=deck#sources");
  });

  it("keeps the OAuth return on its tab after the panel clears the result from the URL", () => {
    window.history.replaceState(null, "", "/integrations?integration=gmail&connected=1");
    render(<IntegrationsTabs tabs={TABS} />);
    expect(panelText()).toBe("mailbox panel");
    expect(window.location.hash).toBe("#mailboxes");
    // What the connector card does once it has read the result: drop the query, keep the anchor.
    act(() => {
      window.history.replaceState(null, "", `/integrations${window.location.hash}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(panelText()).toBe("mailbox panel");
  });

  it("leaves a link to one source's card in the URL, so the panel can bring it into view", () => {
    window.history.replaceState(null, "", "/integrations#source-cm1");
    render(<IntegrationsTabs tabs={TABS} />);
    expect(panelText()).toBe("sources panel");
    expect(window.location.hash).toBe("#source-cm1");
  });

  it("opens a tab on click as a new history entry, and back returns to the tab before", async () => {
    window.history.replaceState(null, "", "/integrations?connections.q=x#sources");
    render(<IntegrationsTabs tabs={TABS} />);
    const entries = window.history.length;

    act(() => fireEvent.click(tab("Mailboxes")));
    expect(panelText()).toBe("mailbox panel");
    expect(`${window.location.search}${window.location.hash}`).toBe("?connections.q=x#mailboxes");
    expect(window.history.length).toBe(entries + 1);

    // Clicking the open tab adds no entry.
    act(() => fireEvent.click(tab("Mailboxes")));
    expect(window.history.length).toBe(entries + 1);

    await back();
    expect(panelText()).toBe("sources panel");
    expect(tab("Knowledge sources").getAttribute("aria-selected")).toBe("true");
  });

  it("follows an anchor link clicked while the page is open", () => {
    render(<IntegrationsTabs tabs={TABS} />);
    act(() => {
      window.location.hash = "#connected-apps";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(panelText()).toBe("apps panel");
  });

  it("moves focus with the arrow keys, Home and End without opening, and opens on Enter", () => {
    render(<IntegrationsTabs tabs={TABS} />);
    const first = tab("Knowledge sources");
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Connectors"));
    expect(panelText()).toBe("sources panel");

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(tab("Connected apps"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Connected apps"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(first);
    expect(panelText()).toBe("sources panel");

    // A native button opens on Enter and Space by clicking itself.
    fireEvent.keyDown(first, { key: "ArrowRight" });
    act(() => fireEvent.click(document.activeElement!));
    expect(panelText()).toBe("connectors panel");
  });
});
