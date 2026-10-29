// The listing names each connection by internal ids and says whether an inbox
// watch it recorded is still live, in both formats the old code wrote, without
// ever printing the mailbox address stored beside them.
import { describe, expect, it } from "vitest";
import { describeMailboxes, watchExpiry } from "./list-connected-mailboxes";

const NOW = new Date("2026-10-14T12:00:00Z");
const row = (provider: string, meta: unknown) => ({
  id: `int_${provider}`,
  orgId: "org_1",
  provider,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  meta,
});

describe("watchExpiry", () => {
  it("reads Gmail's epoch-millisecond string and Outlook's ISO time", () => {
    expect(watchExpiry("gmail", { gmailWatchExpires: "1792000000000" })).toEqual(new Date(1792000000000));
    expect(watchExpiry("outlook", { outlookSubscriptionExpires: "2026-10-15T00:00:00Z" })).toEqual(
      new Date("2026-10-15T00:00:00Z"),
    );
  });

  it("is null when nothing usable is recorded", () => {
    expect(watchExpiry("gmail", {})).toBeNull();
    expect(watchExpiry("gmail", null)).toBeNull();
    expect(watchExpiry("outlook", { outlookSubscriptionExpires: "not a date" })).toBeNull();
    expect(watchExpiry("gmail", { outlookSubscriptionExpires: "2026-10-15T00:00:00Z" })).toBeNull();
  });
});

describe("describeMailboxes", () => {
  it("lists each connection with its watch state and counts the live ones", () => {
    const lines = describeMailboxes(
      [
        row("gmail", { email: "sales@acme.com", gmailWatchExpires: String(Date.parse("2026-10-16T00:00:00Z")) }),
        row("outlook", { email: "ops@acme.com", outlookSubscriptionExpires: "2026-10-10T00:00:00Z" }),
      ],
      NOW,
    );
    expect(lines).toEqual([
      "gmail\tint_gmail\torg org_1\tconnected since 2026-10-01T00:00:00.000Z\twatch live until 2026-10-16T00:00:00.000Z",
      "outlook\tint_outlook\torg org_1\tconnected since 2026-10-01T00:00:00.000Z\twatch expired",
      "2 connected mailboxes, 1 with a live watch",
    ]);
    expect(lines.join("\n")).not.toContain("@acme.com");
  });

  it("says so when there is nothing to revoke", () => {
    expect(describeMailboxes([], NOW)).toEqual(["0 connected mailboxes, 0 with a live watch"]);
  });
});
