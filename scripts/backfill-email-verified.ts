// Fill `User.emailVerified` from Clerk for users stored before the column existed.
// Run once, against the database the app uses, after the migration that added it.
//
// Dry run (default, writes nothing, prints counts):
//   DATABASE_URL=<postgres url> CLERK_SECRET_KEY=<sk_...> npx tsx scripts/backfill-email-verified.ts
// Write:
//   DATABASE_URL=<postgres url> CLERK_SECRET_KEY=<sk_...> npx tsx scripts/backfill-email-verified.ts --apply
//
// Flags: --apply             write the values (default: dry run)
//        --org <Org.id>      only this org's users
//        --page-size <n>     users per page and per Clerk request, 1 to 100 (default 100)
//
// Only fills a null and never changes a value already set, so it is safe to rerun
// and resumes where an interrupted run stopped. Prints counts and internal user
// ids only. The rule and the details live in scripts/lib/backfill-email-verified.ts.
import { pathToFileURL } from "node:url";

export interface BackfillArgs {
  apply: boolean;
  orgId?: string;
  pageSize?: number;
}

/** Parse the command line, refusing anything it does not recognise. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const args: BackfillArgs = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--org") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--org needs an Org.id");
      args.orgId = value;
    } else if (arg === "--page-size") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 100)
        throw new Error("--page-size must be an integer from 1 to 100");
      args.pageSize = value;
    } else {
      throw new Error(`unknown argument "${arg}"; expected --apply, --org <Org.id> or --page-size <n>`);
    }
  }
  return args;
}

/** The required variables that are unset, as one line, or null when both are set. */
export function missingEnv(env: Record<string, string | undefined>): string | null {
  const missing = ["DATABASE_URL", "CLERK_SECRET_KEY"].filter((name) => !env[name]);
  if (missing.length === 0) return null;
  return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`;
}

/**
 * Name what a failure was in one line that cannot carry user data.
 *
 * A Clerk error's body and a Prisma error's message can both echo request values,
 * an email address included, so neither is printed: a Clerk error is named by its
 * HTTP status and trace id, a Prisma error by its class and code. Only the
 * script's own errors keep their message, which names the fix.
 */
export function describeFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const { name, status, clerkTraceId, code } = error as {
    name?: unknown;
    status?: unknown;
    clerkTraceId?: unknown;
    code?: unknown;
  };
  const trace = typeof clerkTraceId === "string" && clerkTraceId ? ` (trace ${clerkTraceId})` : "";
  if (name === "ClerkAPIResponseError") {
    return typeof status === "number"
      ? `Clerk request failed with HTTP ${status}${trace}`
      : `Clerk request failed without an HTTP response${trace}; check the network and rerun`;
  }
  if (typeof name === "string" && name.startsWith("PrismaClient")) {
    return `database error ${name}${typeof code === "string" ? ` ${code}` : ""}`;
  }
  return error instanceof Error ? error.message : "unknown error";
}

async function main(): Promise<number> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const missing = missingEnv(process.env);
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (missing || !secretKey) throw new Error(missing ?? "CLERK_SECRET_KEY is not set");

  const { createClerkClient } = await import("@clerk/backend");
  const { db } = await import("@/lib/db");
  const { backfillEmailVerified } = await import("./lib/backfill-email-verified");
  try {
    console.log(
      args.apply
        ? "backfill-email-verified: APPLY, writing values"
        : "backfill-email-verified: dry run, nothing is written",
    );
    const summary = await backfillEmailVerified(db, createClerkClient({ secretKey }), {
      ...args,
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify(summary));
    return 0;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`backfill-email-verified: ${describeFailure(error)}`);
      process.exit(1);
    },
  );
}
