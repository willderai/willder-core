// Session-state capture redaction: a secret-named key's value on the line after its
// separator. Layer 5 of willder-redact.mjs must allow any whitespace, newlines included,
// between the separator and the value; allowing only spaces and tabs lets a value that a
// formatter or a YAML writer put on the next line reach the stored fact. Prettier puts
// it there by itself: an assignment to a long secret-named constant breaks after the `=`. The value here
// is 24 random characters, under layer 6's 32-character floor and of no known token shape,
// so layer 5 is the only layer that can catch it.
import { describe, expect, it } from "vitest";
import { redact } from "./willder-redact.mjs";

const VALUE = "k7Qp2Xv9Lm3Rt8Wz5Nb1Yc6D";

describe("redact: a secret-named key whose value starts on the next line", () => {
  it.each([
    [
      "an assignment Prettier broke after the =",
      `export const STRIPE_WEBHOOK_SIGNING_SECRET_FOR_LOCAL_INTEGRATION_TESTS_ONLY =\n  "${VALUE}";`,
    ],
    ["an object property Prettier broke after the :", `const c = {\n  apiToken:\n    "${VALUE}",\n};`],
    ["a YAML plain scalar continued on the next line", `db:\n  password:\n    ${VALUE}\nnext: 1`],
  ])("removes %s", (_, text) => {
    expect(redact(text, {})).not.toContain(VALUE);
  });
});
