// Frontend-safe domain types for Willder: shapes a page or component can import
// without pulling in the Prisma client and its server-only code. The one rule:
// everything here mirrors prisma/schema.prisma (the prose companion is
// docs/willder_database.md), and dates are ISO strings, not Date objects.

/** A member's role inside an org. Mirrors the `UserRole` enum in prisma/schema.prisma. */
export type UserRole = "owner" | "admin" | "member";
