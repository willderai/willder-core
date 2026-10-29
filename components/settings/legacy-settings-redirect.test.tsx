// @vitest-environment jsdom
//
// Links written before Settings was split point at /settings: an anchor on a panel that
// moved (dashboard, onboarding, nav search, an audit fact's source, a shared list view)
// or the OAuth callback's ?integration= result. Each must land on the same panel at its
// new page; anything still on Settings, including Clerk's own hash routes, stays put.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LegacySettingsRedirect, legacySettingsTarget } from "./legacy-settings-redirect";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("legacySettingsTarget", () => {
  it.each([
    ["", "#sources", "/integrations#sources"],
    ["", "#connectors", "/integrations#connectors"],
    ["", "#mailboxes", "/integrations#mailboxes"],
    ["", "#source-src%201", "/integrations#source-src%201"],
    ["", "#connect-ai", "/integrations#connect-ai"],
    ["", "#connected-apps", "/integrations#connected-apps"],
    ["?integration=slack&connected=1", "", "/integrations?integration=slack&connected=1"],
    ["?integration=figma&connected=0", "#connectors", "/integrations?integration=figma&connected=0#connectors"],
  ])("moves %s%s to %s", (search, hash, target) => {
    expect(legacySettingsTarget(search, hash)).toBe(target);
  });

  it("keeps a moved list's view when it follows its panel", () => {
    expect(legacySettingsTarget("?connections.q=ci&connections.sort=name", "#connect-ai")).toBe(
      "/integrations?connections.q=ci&connections.sort=name#connect-ai",
    );
    expect(legacySettingsTarget("?sources.q=drive", "#sources")).toBe("/integrations?sources.q=drive#sources");
  });

  it.each([
    "?connections.q=ci",
    "?disconnected.sort=revoked",
    "?apps.filter.permission=read",
    "?connectors.q=slack",
    "?sources.q=drive&apps.q=claude",
  ])("moves a list view %s with no anchor, since only a moved panel reads it", (search) => {
    expect(legacySettingsTarget(search, "")).toBe(`/integrations${search}`);
  });

  it("sends the memory chat name to the chat it names, without Settings' query", () => {
    expect(legacySettingsTarget("", "#memory-chat")).toBe("/memory/ask#memory-chat");
    expect(legacySettingsTarget("?members.q=ada", "#memory-chat")).toBe("/memory/ask#memory-chat");
    expect(legacySettingsTarget("?connections.q=ci", "#memory-chat")).toBe("/memory/ask#memory-chat");
  });

  it("follows the name field's own id, the one anchor Settings had for it", () => {
    expect(legacySettingsTarget("", "#memory-chat-name")).toBe("/memory/ask#memory-chat-name");
  });

  it.each([
    ["#connect%2Dai", "/integrations#connect%2Dai"],
    ["#connected%2Dapps", "/integrations#connected%2Dapps"],
    ["#memory%2Dchat", "/memory/ask#memory%2Dchat"],
  ])("matches a percent-encoded anchor %s as the browser does", (hash, target) => {
    expect(legacySettingsTarget("", hash)).toBe(target);
  });

  it("leaves a malformed percent-encoding on Settings instead of throwing", () => {
    expect(legacySettingsTarget("", "#%E0%A4%A")).toBeNull();
  });

  it.each([
    ["?connections.q=ci", "#/organization-members"],
    ["?apps.q=claude", "#aliases"],
    ["?sources.q=drive", "#org-roles"],
    ["?disconnected.sort=revoked", "#members"],
  ])("keeps %s%s on Settings: the anchor names something still here", (search, hash) => {
    expect(legacySettingsTarget(search, hash)).toBeNull();
  });

  it("takes an OAuth result to Integrations without an anchor that would land nowhere there", () => {
    expect(legacySettingsTarget("?integration=slack&connected=1", "#aliases")).toBe(
      "/integrations?integration=slack&connected=1",
    );
    expect(legacySettingsTarget("?integration=slack&connected=1", "#")).toBe(
      "/integrations?integration=slack&connected=1",
    );
  });

  it("treats a bare # as no anchor", () => {
    expect(legacySettingsTarget("?connections.q=ci", "#")).toBe("/integrations?connections.q=ci");
  });

  it.each([
    ["", ""],
    ["", "#/organization-members"],
    ["", "#members"],
    ["", "#org-roles"],
    ["", "#aliases"],
    ["?tab=members", ""],
    ["?members.q=ada", ""],
    ["?roles.sort=title", ""],
    ["?aliases.q=jane", ""],
    // A Settings list's view rides along, so the page it belongs to wins.
    ["?members.q=ada&connections.q=ci", ""],
    // Near misses: a longer word, a different case, a prefix without its dot.
    ["", "#sourcesx"],
    ["", "#connect-aix"],
    ["", "#Connect-AI"],
    ["", "#memory-chatx"],
    ["", "#memory-chat-namex"],
    ["?connectionsq=ci", ""],
    ["?appsq=claude", ""],
    // Anchored at both ends, and a prefix only at the start of a parameter.
    ["", "#x#sources"],
    ["", "#sources#x"],
    ["", "#source-"],
    ["?x.connections.q=ci", ""],
    ["?members.connections.q=ci", ""],
  ])("leaves %s%s on Settings", (search, hash) => {
    expect(legacySettingsTarget(search, hash)).toBeNull();
  });
});

describe("LegacySettingsRedirect", () => {
  function mountAt(url: string) {
    const replace = vi.fn();
    const { search, hash } = new URL(url, "http://localhost");
    vi.stubGlobal("location", { ...window.location, search, hash, replace });
    render(<LegacySettingsRedirect />);
    return replace;
  }

  it("replaces an old link, so Back does not return to the stale URL", () => {
    expect(mountAt("/settings#source-abc")).toHaveBeenCalledWith("/integrations#source-abc");
    expect(mountAt("/settings#connect-ai")).toHaveBeenCalledWith("/integrations#connect-ai");
  });

  it("does nothing on an ordinary Settings visit", () => {
    expect(mountAt("/settings")).not.toHaveBeenCalled();
    expect(mountAt("/settings#/organization-members")).not.toHaveBeenCalled();
  });
});
