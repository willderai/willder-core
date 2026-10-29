// Give memory rows stored before passage embeddings existed their passages, so vector
// search reads all of a long row, not only its first 512 tokens. Run after the
// 20261011100000_memory_chunk_passages migration is applied and the app that writes
// passages on ingest is deployed; rows ingested after that already have them.
//
// Dry run (default, writes nothing, prints counts and the storage the passages will take):
//   DATABASE_URL=<postgres url> GRAPHITI_SERVICE_URL=<memory service url> GRAPHITI_SERVICE_API_KEY=<key> \
//     npx tsx scripts/backfill-passage-embeddings.ts
// Write:
//   ... npx tsx scripts/backfill-passage-embeddings.ts --apply
//
// Flags: --apply              write passages (default: dry run)
//        --org <Org.id>       only this org's rows
//        --rate <n>           at most n passage embeddings per second (default 10)
//        --max-rows <n>       stop after n rows; a rerun continues
//        --page-size <n>      rows per database page, 1 to 1000 (default 100)
//
// Only ever adds passages to a row that has none, so it is safe to rerun and resumes
// where an interrupted run stopped. Prints counts and row ids only. The rule and the
// details live in services/memory/passage-backfill.ts.
import { pathToFileURL } from "node:url";

export interface PassageBackfillArgs {
  apply: boolean;
  orgId?: string;
  maxEmbeddingsPerSecond?: number;
  maxRows?: number;
  pageSize?: number;
}

/** Parse the command line, refusing anything it does not recognise. */
export function parsePassageBackfillArgs(argv: readonly string[]): PassageBackfillArgs {
  const args: PassageBackfillArgs = { apply: false };
  const positive = (flag: string, raw: string | undefined, max: number) => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`${flag} must be an integer from 1 to ${max}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--org") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--org needs an Org.id");
      args.orgId = value;
    } else if (arg === "--rate") args.maxEmbeddingsPerSecond = positive(arg, argv[++i], 1_000);
    else if (arg === "--max-rows") args.maxRows = positive(arg, argv[++i], Number.MAX_SAFE_INTEGER);
    else if (arg === "--page-size") args.pageSize = positive(arg, argv[++i], 1_000);
    else
      throw new Error(
        `unknown argument "${arg}"; expected --apply, --org <Org.id>, --rate <n>, --max-rows <n> or --page-size <n>`,
      );
  }
  return args;
}

/** The required variables that are unset, as one line, or null when all are set. */
export function missingEnv(env: Record<string, string | undefined>, apply: boolean): string | null {
  const required = apply ? ["DATABASE_URL", "GRAPHITI_SERVICE_URL", "GRAPHITI_SERVICE_API_KEY"] : ["DATABASE_URL"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length === 0) return null;
  return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`;
}

/**
 * Name a failure in one line that cannot carry row content: a database error by its
 * class and code, since a Postgres error can echo a value; anything else by its
 * message, which the embedding call and this script write to name the fix.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name.startsWith("PrismaClient")) {
    const code = (error as { code?: unknown }).code;
    return `database error ${error.name}${typeof code === "string" ? ` ${code}` : ""}`;
  }
  return error.message;
}

async function main(): Promise<number> {
  const args = parsePassageBackfillArgs(process.argv.slice(2));
  const missing = missingEnv(process.env, args.apply);
  if (missing) throw new Error(missing);

  const { db } = await import("@/lib/db");
  const { backfillPassages } = await import("@/services/memory/passage-backfill");
  try {
    console.log(
      args.apply
        ? "backfill-passage-embeddings: APPLY, writing passages"
        : "backfill-passage-embeddings: dry run, nothing is written",
    );
    const summary = await backfillPassages(db, { ...args, log: (line) => console.log(line) });
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
      console.error(`backfill-passage-embeddings: ${describeFailure(error)}`);
      process.exit(1);
    },
  );
}
