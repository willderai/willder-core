// Two redaction cases on session-state capture.
//
// 1. Random base64 with a `/` in it must not pass layer 6 more often than plain words do.
//    A short slice of base64 is "written in words" (mostly lower case at 0.7, letter pieces
//    averaging 3+) often enough that two slices vote a secret into path mode; the bar for
//    lowerCaseMostly is 0.85 so they do not. The samples below are secrets the lower bar
//    leaked.
// 2. A flag such as `--passWithNoTests` only contains a secret word ("pass"); a jest or
//    vitest command, the very thing "Last test command" records, keeps its test path.
import { describe, expect, it } from "vitest";
import { redact } from "./willder-redact.mjs";

const SAMPLES = [
  "GiIywj1vxrq//31CkNVi71M1eSndr6q9AHZza7Se9H/mcnmu",
  "W8AdZsG8J0/jkmoRm25Lr2Gkuxi/31dqq5MphumE",
  "kDte7Y7Ys2cbNKHD/qnaRlqfr7ghmE/lejquzoETeouhYfmp",
  "dvtreDmMohsyFJ//D9jnjvBvcOsXnzpl",
  "uva7hsNunqcxwiPw/Bse7cy/sSqGINMe/IJ/rqixzxXMw/os",
  "lfhgasm8atqHj99/abHhNpbslpFbdvsTvtqvaYCk",
  "/kx8Urt9rgrcHtaa/Lhm2qnKJScckfbf",
  "P9LsY0RVb5WUySeAXQS68BSeXd/RskZnr2bdz/EsAvjipib1",
  "nvboCSHb9VMrkIKS8/oKpwnjqe3GwyLmIq/9hxrf",
  "FyOtnoksiA/Mn7IcsJodbx29/CpaLmTj4SQFeLrkghNt5//1",
];

describe("redact: random base64 with slashes", () => {
  it.each(SAMPLES)("removes %s", (secret) => {
    expect(redact(`Set the secret to ${secret} in Vercel.`, {})).not.toContain(secret);
  });
});

describe("redact: test-runner flags that only contain a secret word", () => {
  it.each(["npx jest --passWithNoTests services/orders", "npx vitest run --passWithNoTests cli/hooks"])(
    "keeps %s",
    (command) => {
      expect(redact(command, {})).toBe(command);
    },
  );

  it("still removes the value of a secret flag", () => {
    expect(redact("vercel deploy --token Ab3dEf6hIj9kLm2nOp5q", {})).not.toContain("Ab3dEf6hIj9kLm2nOp5q");
  });
});
