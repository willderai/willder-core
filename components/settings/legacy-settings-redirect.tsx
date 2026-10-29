"use client";

import { useEffect } from "react";

// Settings used to hold everything. What connects to Willder now lives on
// /integrations: sources, connectors and mailboxes, Connect your AI, Connected apps.
// The memory chat name moved next to the chat it names, on /memory/ask. Links made
// before the moves still point at Settings, and the hash never reaches the server, so
// they are forwarded here, in the browser, on the Settings page itself. The anchor
// decides first, since it names the panel the link was for:
//
// - an anchor on a moved panel goes with it, query and all: `#sources`, `#connectors`,
//   `#mailboxes`, `#source-<id>`, `#connect-ai`, `#connected-apps` to Integrations,
//   `#memory-chat` and the name field's own `#memory-chat-name` to Ask;
// - any other anchor (Clerk's `#/organization-…` routes, `#org-roles`, `#aliases`)
//   names something still on Settings, so the link stays, whatever its query says;
// - with no anchor, the OAuth callback's `?integration=<provider>&connected=0|1` goes to
//   Integrations, and so does a query made only of moved panels' list views
//   (`?connections.q=…`). A query that also holds a Settings list's view (`members.`,
//   `roles.`, `aliases.`) stays, since that list is still here.
// The OAuth result also goes to Integrations under an anchor that stays, without the
// anchor: the result is what that page exists to show, and the anchor means nothing there.

const INTEGRATIONS_ANCHOR = /^#(sources|connectors|mailboxes|source-.+|connect-ai|connected-apps)$/;
const MEMORY_CHAT_ANCHOR = /^#memory-chat(-name)?$/;

/** List-state prefixes (components/list-controls) of the panels now on Integrations. */
const MOVED_LIST_PREFIXES = ["sources.", "connectors.", "connections.", "disconnected.", "apps."];

/** True when the query holds at least one parameter and each is a moved panel's list view. */
function onlyMovedListViews(params: URLSearchParams): boolean {
  const keys = [...params.keys()];
  return keys.length > 0 && keys.every((key) => MOVED_LIST_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

/** The anchor as the browser matches it against ids: percent-decoded. */
function anchorOf(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/** Where an old Settings URL now lives, or null when it stays on Settings. */
export function legacySettingsTarget(search: string, hash: string): string | null {
  const anchor = anchorOf(hash);
  if (INTEGRATIONS_ANCHOR.test(anchor)) return `/integrations${search}${hash}`;
  if (MEMORY_CHAT_ANCHOR.test(anchor)) return `/memory/ask${hash}`;

  const params = new URLSearchParams(search);
  if (params.has("integration")) return `/integrations${search}`;
  const hasAnchor = anchor !== "" && anchor !== "#";
  if (!hasAnchor && onlyMovedListViews(params)) return `/integrations${search}`;
  return null;
}

/** Sends a Settings link made before the split on to its new page, replacing the history entry. */
export function LegacySettingsRedirect() {
  useEffect(() => {
    const target = legacySettingsTarget(window.location.search, window.location.hash);
    if (target) window.location.replace(target);
  }, []);
  return null;
}
