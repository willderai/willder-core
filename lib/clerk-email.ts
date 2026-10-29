// Whether the email Willder stores for a person is an address Clerk verified.
//
// Source-connect widening (services/access/source-widening.ts) matches the people
// who can read a scope to a source's sharing list by email. An address nobody has
// proved they own must never count as a match, or the widening a connect reports
// comes out too low. This module turns Clerk's list of a user's addresses into the
// one value stored on `User.emailVerified`.
//
// The rule it enforces: verification is about the exact address Willder stores and
// matches on, not about the account. An address Clerk does not list for the user,
// or lists without a completed verification, is unverified.

/** One of a Clerk user's email addresses, with whether Clerk verified it. */
export interface ClerkEmail {
  address: string;
  verified: boolean;
}

/** Whether `storedEmail` is one of `addresses` and Clerk verified it. Case is ignored. */
export function storedEmailVerified(storedEmail: string, addresses: readonly ClerkEmail[]): boolean {
  const stored = storedEmail.trim().toLowerCase();
  return addresses.some((a) => a.verified && a.address.trim().toLowerCase() === stored);
}

/** The addresses on a Clerk Backend API user (`currentUser()`, `users.getUser()`). */
export function emailsOfClerkUser(user: {
  emailAddresses: readonly { emailAddress: string; verification: { status: string } | null }[];
}): ClerkEmail[] {
  return user.emailAddresses.map((e) => ({
    address: e.emailAddress,
    verified: e.verification?.status === "verified",
  }));
}

/** The addresses on a Clerk `user.created` / `user.updated` webhook payload. */
export function emailsOfClerkWebhookUser(data: {
  email_addresses?: readonly { email_address: string; verification?: { status?: string } | null }[];
}): ClerkEmail[] {
  return (data.email_addresses ?? []).map((e) => ({
    address: e.email_address,
    verified: e.verification?.status === "verified",
  }));
}
