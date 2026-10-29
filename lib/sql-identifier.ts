// A name spliced into SQL as an identifier (a CTE's name), never a value. Values are bound
// parameters; a name cannot be, so it is held to lower-case letters, digits and underscores,
// starting with a letter or underscore, and anything else throws before any SQL is built.
import { Prisma } from "@/lib/generated/prisma/client";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * `name` as a quoted SQL identifier.
 *
 * @throws Error when `name` is not lower-case letters, digits and underscores starting with a letter or underscore.
 */
export function sqlIdentifier(name: string): Prisma.Sql {
  if (!IDENTIFIER.test(name)) throw new Error(`not a SQL identifier this code splices: ${JSON.stringify(name)}`);
  return Prisma.raw(`"${name}"`);
}
