// Export a self-hosted install's memory from the command line, with no web session: the
// same code and the same file as GET /api/memory/export (services/memory/org-export.ts,
// docs/export-format.md), as a person of the self-host org.
//
// Run: npm run selfhost:export -- [--scope <path>] [--out <file>] [--as <email>]
//   --scope  one scope below the org root, like team or team.alpha: export it and its
//            descendants only (default: everything the person may read)
//   --out    the file to write; refused if it exists (default: standard output)
//   --as     the member to export as (default: the operator selfhost:token created)
//
// The export follows that person's access exactly as the web export does: a scope they
// cannot read is refused, and the refusal is in the audit log. Only self-host orgs are
// exported (scripts/lib/selfhost.ts); the same environment refusals as selfhost:token apply.
import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { selfhostTargetRefusal } from "./lib/local-database-guard";

const USAGE = "usage: npm run selfhost:export -- [--scope <path>] [--out <file>] [--as <email>]";

interface ExportArgs {
  scope: string | undefined;
  out: string | undefined;
  as: string | undefined;
  org: string;
}

function exportArgs(argv: string[]): ExportArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      scope: { type: "string" },
      out: { type: "string" },
      as: { type: "string" },
      // The smoke test's own org (scripts/selfhost-smoke.ts); not part of the documented interface.
      org: { type: "string", default: "default" },
    },
  });
  if (values.out !== undefined && !values.out.trim()) throw new Error("--out must name a file");
  if (values.as !== undefined && !values.as.trim()) throw new Error("--as must name a member's email");
  return { scope: values.scope?.trim(), out: values.out, as: values.as?.trim(), org: values.org };
}

/** A stream to `file`, which must not exist yet; resolves once the file is created. */
function openNewFile(file: string): Promise<WriteStream> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(file, { flags: "wx" });
    stream.once("open", () => resolve(stream));
    stream.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        new Error(
          e.code === "EEXIST"
            ? `--out ${file} already exists; name a new file`
            : `cannot create --out ${file}: ${e.message}`,
        ),
      ),
    );
  });
}

/** Close and remove a file this command created and wrote nothing to. */
async function discard(stream: NodeJS.WritableStream, file: string): Promise<void> {
  await new Promise<void>((resolve) => (stream as WriteStream).close(() => resolve()));
  await rm(file, { force: true });
}

async function main() {
  const refusal = selfhostTargetRefusal(process.env);
  if (refusal) {
    console.error(`selfhost:export: refusing to run: ${refusal}.`);
    process.exit(1);
  }
  let args: ExportArgs;
  try {
    args = exportArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`selfhost:export: ${e instanceof Error ? e.message : e}\n${USAGE}`);
    process.exit(1);
  }
  // Imported only after the guard passes, so no connection is opened to a refused target.
  const { assertDatabaseReachable } = await import("@/lib/db-startup");
  await assertDatabaseReachable();
  const { db } = await import("@/lib/db");
  const { isSelfhostOrgName, scopePathIn, selfhostPerson } = await import("./lib/selfhost");
  const { exportMemory } = await import("@/services/memory/org-export");
  const { AccessDeniedError } = await import("@/services/access");
  try {
    if (!isSelfhostOrgName(args.org)) throw new Error(`--org must be default or smoke, got "${args.org}"`);
    const person = await selfhostPerson(args.org, args.as);
    const scope = args.scope === undefined ? undefined : scopePathIn(person.orgId, args.scope);
    // The file is opened before the export starts, so an --out that exists or cannot be made
    // fails before the export writes its audit row; a refusal then removes the empty file.
    const destination = args.out === undefined ? process.stdout : await openNewFile(args.out);
    const lines = exportMemory(person.ctx, new Date(), { scope });
    let first: IteratorResult<string>;
    try {
      first = await lines.next();
    } catch (e) {
      if (args.out !== undefined) await discard(destination, args.out);
      if (e instanceof AccessDeniedError) throw new Error(`refused: ${e.decision.reason}`);
      throw e;
    }
    let last = first.done ? "" : first.value;
    async function* all(): AsyncGenerator<string> {
      if (first.done) return;
      yield first.value;
      for await (const line of lines) {
        last = line;
        yield line;
      }
    }
    try {
      await pipeline(Readable.from(all()), destination, { end: args.out !== undefined });
    } catch (e) {
      if (args.out !== undefined) await rm(args.out, { force: true });
      throw e;
    }
    const end = JSON.parse(last) as { type: string; counts?: Record<string, number> };
    if (end.type !== "end" || !end.counts) throw new Error("the export ended without its end record");
    const counts = Object.entries(end.counts)
      .map(([type, n]) => `${n} ${type}`)
      .join(", ");
    console.error(
      `selfhost:export: exported ${args.scope ? `scope ${args.scope}` : "every readable scope"} as ${person.email}: ${counts}${args.out ? ` to ${args.out}` : ""}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(`selfhost:export failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
