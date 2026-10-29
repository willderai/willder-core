// Remove the facts a measure run left in the demo scope, by the run's tag.
//
// First list them. The dry run changes no memory; it prints one JSON line with every fact
// of the run in the demo scope and the counts per table, for someone to review:
//   DATABASE_URL=<postgres url> DEMO_ORG_ID=<org id> DEMO_SCOPE_PATH=<demo scope path> \
//   npx tsx scripts/cleanup-run-tag.ts --org "$DEMO_ORG_ID" --scope "$DEMO_SCOPE_PATH" \
//     --as <User.id> --tag ltload-20261005213000 > reviewed-ltload-20261005213000.jsonl
// Then remove what was reviewed, each fact through the product's own fact delete:
//   ... --org "$DEMO_ORG_ID" --scope "$DEMO_SCOPE_PATH" --as <User.id> \
//     --apply --reviewed reviewed-ltload-20261005213000.jsonl
// The removal prints the run's tag before it removes anything. Only a reviewed fact that is
// still one of that run's tagged facts in the demo scope is removed; any other id in the
// file is skipped and named. The file is not signed: an edited tag would point the removal
// at another run's tagged facts in the demo scope, never at anything untagged.
//
// Flags: --org, --scope       must equal DEMO_ORG_ID and DEMO_SCOPE_PATH, or the run is
//                             refused before the database is read
//        --as <User.id>       the demo org user every read and removal is authorized as and
//                             audited under; it needs write on the demo scope to remove
//        --tag <tag>          (dry run) the one run to list
//        --apply --reviewed <file>   remove what the dry run in <file> listed
//
// Prints one JSON line. Exit 0 on success, 1 when refused or failed. Sending the same
// removal again continues one that stopped part-way. The rules and what each removal keeps
// are in services/memory/run-tag-cleanup.ts.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AccessContext } from "@/services/access";
import type { RunTagInventory } from "@/services/memory/run-tag-cleanup";

export type CleanupArgs =
  | { mode: "list"; orgId: string; scopePath: string; actingUserId: string; tag: string }
  | { mode: "apply"; orgId: string; scopePath: string; actingUserId: string; reviewedFile: string };

/** Parse the command line, refusing anything it does not recognise, anything missing, or a mix of the two modes. */
export function parseCleanupArgs(argv: readonly string[]): CleanupArgs {
  let orgId = "";
  let scopePath = "";
  let actingUserId = "";
  let reviewedFile = "";
  let apply = false;
  const tags: string[] = [];
  const valueOf = (i: number, flag: string): string => {
    const value = argv[i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--org") orgId = valueOf(++i, "--org");
    else if (arg === "--scope") scopePath = valueOf(++i, "--scope");
    else if (arg === "--as") actingUserId = valueOf(++i, "--as");
    else if (arg === "--tag") tags.push(valueOf(++i, "--tag"));
    else if (arg === "--reviewed") reviewedFile = valueOf(++i, "--reviewed");
    else throw new Error(`unknown argument "${arg}"; expected --org, --scope, --as, --tag, --apply or --reviewed`);
  }
  if (!orgId || !scopePath || !actingUserId) {
    throw new Error(
      "--org, --scope and --as <User.id> are required: every read and removal is authorized and audited as a person",
    );
  }
  if (!apply) {
    if (reviewedFile) throw new Error("--reviewed is for --apply; a dry run lists by --tag");
    if (tags.length !== 1) throw new Error("a dry run lists one run: pass exactly one --tag");
    return { mode: "list", orgId, scopePath, actingUserId, tag: tags[0]! };
  }
  if (tags.length > 0)
    throw new Error("--apply removes what a reviewed dry run listed: pass --reviewed <file>, not --tag");
  if (!reviewedFile) throw new Error("--apply needs --reviewed <file>, the dry run's output after review");
  return { mode: "apply", orgId, scopePath, actingUserId, reviewedFile };
}

/**
 * The one dry run a reviewed file holds. Refuses an empty file, a line that is not JSON or
 * not a dry run of this command, and a file covering more than one run, so the removal is
 * always of exactly the run it prints.
 */
export function reviewedInventory(text: string): RunTagInventory {
  const lines = text
    .split("\n")
    .map((line, i) => ({ line, number: i + 1 }))
    .filter(({ line }) => line.trim() !== "");
  if (lines.length === 0)
    throw new Error("the reviewed file holds no dry-run line; pass the dry run's output unchanged");
  const inventories = lines.map(({ line, number }) => {
    let parsed: Partial<RunTagInventory> & { dryRun?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      throw new Error(`line ${number} of the reviewed file is not JSON; pass the dry run's output unchanged`);
    }
    const shaped =
      parsed.dryRun === true &&
      typeof parsed.orgId === "string" &&
      typeof parsed.scopePath === "string" &&
      typeof parsed.tag === "string" &&
      Array.isArray(parsed.facts) &&
      parsed.facts.every((f) => typeof f?.id === "string");
    if (!shaped)
      throw new Error(
        `line ${number} of the reviewed file is not a dry-run line of this command; pass the dry run's output unchanged`,
      );
    return parsed as RunTagInventory;
  });
  if (inventories.length > 1) {
    throw new Error(
      `the reviewed file holds ${inventories.length} dry runs (${inventories.map((i) => i.tag).join(", ")}); review and remove one run per file`,
    );
  }
  return inventories[0]!;
}

async function main(): Promise<void> {
  const args = parseCleanupArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const { GRAPH_REMOVAL, assertCleanupAllowed, demoTargetFrom, inventoryRunTag, removeRunTag } = await import(
    "@/services/memory/run-tag-cleanup"
  );
  // Every refusal that needs no database comes first, so a refused request reads nothing.
  const demo = demoTargetFrom(process.env);
  const reviewed = args.mode === "apply" ? reviewedInventory(readFileSync(args.reviewedFile, "utf8")) : null;
  const request = {
    orgId: args.orgId,
    scopePath: args.scopePath,
    tag: args.mode === "list" ? args.tag : reviewed!.tag,
  };
  assertCleanupAllowed(request, demo);
  if (reviewed) assertCleanupAllowed(reviewed, demo);

  const { db } = await import("@/lib/db");
  try {
    // The role comes from the database, never from the command line.
    const user = await db.user.findFirst({
      where: { id: args.actingUserId, orgId: demo.orgId },
      select: { role: true },
    });
    if (!user) throw new Error(`no user ${args.actingUserId} in the demo org`);
    const ctx: AccessContext = {
      orgId: demo.orgId,
      actor: { type: "human", id: args.actingUserId, role: user.role },
      origin: "script",
    };
    if (!reviewed) {
      console.log(JSON.stringify({ dryRun: true, ...(await inventoryRunTag(ctx, request, demo)) }));
      return;
    }
    console.error(
      `REMOVING run ${reviewed.tag} from ${reviewed.scopePath}: ${reviewed.facts.length} reviewed facts, each only if still tagged ${reviewed.tag}`,
    );
    const removal = await removeRunTag(ctx, reviewed, demo);
    console.log(JSON.stringify({ dryRun: false, tag: reviewed.tag, ...removal, graph: GRAPH_REMOVAL }));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`cleanup-run-tag: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
