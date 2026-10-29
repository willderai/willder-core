// Which stored email counts as verified: only the exact address, verified by Clerk.
import { describe, expect, it } from "vitest";
import { emailsOfClerkUser, emailsOfClerkWebhookUser, storedEmailVerified } from "./clerk-email";

describe("storedEmailVerified", () => {
  const addresses = [
    { address: "Ana@Acme.test", verified: true },
    { address: "ana@personal.test", verified: false },
  ];

  it("is true only for a listed address Clerk verified, ignoring case", () => {
    expect(storedEmailVerified("ana@acme.test", addresses)).toBe(true);
  });

  it("is false for a listed address Clerk has not verified", () => {
    expect(storedEmailVerified("ana@personal.test", addresses)).toBe(false);
  });

  it("is false for an address Clerk does not list, even when another address is verified", () => {
    expect(storedEmailVerified("someone@acme.test", addresses)).toBe(false);
    expect(storedEmailVerified("user_1@no-email.local", [])).toBe(false);
  });
});

describe("reading Clerk's address lists", () => {
  it("reads a Backend API user", () => {
    expect(
      emailsOfClerkUser({
        emailAddresses: [
          { emailAddress: "a@x.test", verification: { status: "verified" } },
          { emailAddress: "b@x.test", verification: { status: "unverified" } },
          { emailAddress: "c@x.test", verification: null },
        ],
      }),
    ).toEqual([
      { address: "a@x.test", verified: true },
      { address: "b@x.test", verified: false },
      { address: "c@x.test", verified: false },
    ]);
  });

  it("reads a webhook payload, including one with no addresses", () => {
    expect(
      emailsOfClerkWebhookUser({
        email_addresses: [
          { email_address: "a@x.test", verification: { status: "verified" } },
          { email_address: "b@x.test", verification: null },
        ],
      }),
    ).toEqual([
      { address: "a@x.test", verified: true },
      { address: "b@x.test", verified: false },
    ]);
    expect(emailsOfClerkWebhookUser({})).toEqual([]);
  });
});
