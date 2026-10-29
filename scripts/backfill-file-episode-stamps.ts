// Stamp, or retire, the graph episodes of uploaded files written before each passage's chunk
// id was stamped on its episode. Without the stamp, removing the upload or erasing a
// person leaves the file's graph facts readable. The rule and the details live in
// services/memory/file-episode-stamps.ts.
//
// Dry run (default; reads only, writes nothing, prints counts only):
//   DATABASE_URL=<postgres url> GRAPHITI_SERVICE_URL=<memory service url> GRAPHITI_SERVICE_API_KEY=<key> \
//     npx tsx scripts/backfill-file-episode-stamps.ts
// Write (refused without the recorded operator approval that allowed it):
//   ... npx tsx scripts/backfill-file-episode-stamps.ts --apply --decision approval-<slug>-<yyyymmdd>
//
// Flags: --apply                write stamps and retire orphans (default: dry run)
//        --decision <id>        the recorded approval id for an applied run; required with --apply
//        --org <Org.id>         only this org
//        --page-size <n>        episodes per memory-service page, 1 to 500 (default 200)
//
// Production reads need an operator's explicit approval too: do not run even the dry run
// against production without it.
// Safe to rerun: a second run writes nothing. Never prints memory text or a filename. It
// retires only what the change feed records as removed; anything it cannot place is counted
// and left. Each run hashes with its own random salt.
import { pathToFileURL } from "node:url";
import { assertMayApply } from "@/services/memory/file-episode-stamps";

export interface FileEpisodeStampArgs {
  apply: boolean;
  decisionId?: string;
  orgId?: string;
  pageSize?: number;
}

/** Parse the command line, refusing anything it does not recognise, and an applied run without a decision. */
export function parseFileEpisodeStampArgs(argv: readonly string[]): FileEpisodeStampArgs {
  const args: FileEpisodeStampArgs = { apply: false };
  const value = (flag: string, raw: string | undefined, what: string) => {
    if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs ${what}`);
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--decision") args.decisionId = value(arg, argv[++i], "a recorded approval id");
    else if (arg === "--org") args.orgId = value(arg, argv[++i], "an Org.id");
    else if (arg === "--page-size") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error("--page-size must be an integer from 1 to 500");
      args.pageSize = n;
    } else
      throw new Error(
        `unknown argument "${arg}"; expected --apply, --decision <id>, --org <Org.id> or --page-size <n>`,
      );
  }
  if (args.decisionId && !args.apply)
    throw new Error("--decision is for an applied run; pass --apply with it, or neither for a dry run");
  assertMayApply(args);
  return args;
}

/** The required variables that are unset, as one line, or null when all are set. */
export function missingEnv(env: Record<string, string | undefined>): string | null {
  const missing = ["DATABASE_URL", "GRAPHITI_SERVICE_URL", "GRAPHITI_SERVICE_API_KEY"].filter((name) => !env[name]);
  if (missing.length === 0) return null;
  return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`;
}

async function main(): Promise<number> {
  const args = parseFileEpisodeStampArgs(process.argv.slice(2));
  const missing = missingEnv(process.env);
  if (missing) throw new Error(missing);
  const { db } = await import("@/lib/db");
  const { graphitiStore } = await import("@/services/memory/store");
  const { backfillFileEpisodeStamps } = await import("@/services/memory/file-episode-stamps");
  try {
    const summary = await backfillFileEpisodeStamps(db, graphitiStore, { ...args, log: (line) => console.log(line) });
    console.log(JSON.stringify(summary));
    return 0;
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      // A Postgres error can echo a value, so only its class and code are printed.
      const name = e instanceof Error ? e.name : "Error";
      console.error(
        name.startsWith("PrismaClient") ? `database error ${name}` : e instanceof Error ? e.message : String(e),
      );
      process.exit(1);
    },
  );
}
