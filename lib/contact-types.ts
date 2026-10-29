// The closed set of types a contact can carry.
//
// The one rule this file enforces: every surface that labels a contact picks
// from this list, so a type never exists in only one place.
/** Every contact type, in display order. */
export const CONTACT_TYPES = [
  "prospect",
  "customer",
  "investor",
  "partner",
  "advisor",
  "vendor",
  "team",
  "other",
] as const;
/** One of `CONTACT_TYPES`. */
export type ContactType = (typeof CONTACT_TYPES)[number];
