// Each clause of the GitHub what-we-store line that
// says a shape of secret is removed holds for the forms that shape takes in a real README,
// issue or commit, through the same scan every stored GitHub text goes through
// (services/connectors/github.ts, storable()). Values are built from parts so no literal
// credential sits in the repository.

import { describe, expect, it } from "vitest";
import { WHAT_WE_STORE } from "@/components/settings/connector-data";
import { scanForSecrets } from "./secret-scan";

const stored = (text: string) => scanForSecrets(text, { removeEmails: true }).text;
const SECRET = ["Zq9", "xLm42", "pWr7"].join("");
const line = WHAT_WE_STORE.github;

describe("GitHub what-we-store line: every form of a promised shape is removed", () => {
  it("'long bearer tokens': the auth scheme is case-insensitive, so a lower- or upper-case bearer token goes too", () => {
    // Goes green either way the claim is made true: the scan removes these forms, or the line
    // narrows the clause to the form it removes (then this clause no longer says it).
    if (!/long bearer tokens/.test(line)) return;
    for (const header of [
      `Authorization: Bearer ${SECRET.repeat(3)}`,
      `curl -H "authorization: bearer ${SECRET.repeat(3)}"`,
      `AUTHORIZATION: BEARER ${SECRET.repeat(3)}`,
    ]) {
      expect(stored(header), header).not.toContain(SECRET);
    }
  });

  it("'passwords inside links': a link with a password and no user name loses it too", () => {
    // A host with no letter-only top-level domain, so the email pattern does not remove it by chance.
    if (!/passwords inside links/.test(line)) return;
    for (const url of [
      "postgres:" + `//admin:${SECRET}@db.internal/app`,
      "REDIS_URL=redis:" + `//:${SECRET}@cache:6379`,
      "redis:" + `//:${SECRET}@10.0.0.5:6379/0`,
    ]) {
      expect(stored(url), url).not.toContain(SECRET);
    }
  });

  it("'a similar name': every name the line calls similar to password or api_key is one the scan removes after", () => {
    // Either the line names the names the scan reads (password, secret, api key, token), or
    // the common short forms of them are removed as well.
    if (!/similar name/.test(line)) return;
    for (const assignment of [`DB_PASS=${SECRET}`, `pwd=${SECRET}`]) {
      expect(stored(assignment), assignment).not.toContain(SECRET);
    }
  });
});
