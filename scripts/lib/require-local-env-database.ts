// Preloaded by scripts/run-check.sh whenever it loads the default `.env`.
//
// A developer's `.env` is a local file, so a database URL in it must be on this
// machine: a production URL left there would make every check script, and
// `npm run mcp`, read and write production without anyone naming it. To run
// against a remote database on purpose, name it: export DATABASE_URL, or pass
// ENV_FILE=<file>. Neither path loads this guard's refusal.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { envFileDatabaseRefusal } from "./local-database-guard";

const refusal = envFileDatabaseRefusal(parseEnv(readFileSync(".env", "utf8")), process.env);
if (refusal) {
  console.error(
    `run-check: refusing to run: ${refusal} (from .env). Keep .env pointed at a local database; ` +
      "to use a remote one on purpose, export DATABASE_URL or pass ENV_FILE=<file>.",
  );
  process.exit(1);
}
