// Coverage for the bypass-credentials check (scripts/check-bypass-credentials.mjs).
//
// The check is a security claim about the README, so it has to fail in each way
// the README can be wrong: a credential the code reads that nobody classified, a
// listed credential nothing reads any more, and a name given both answers. The
// last block runs it against this repository, with and without a README row.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  README_HEADING,
  classify,
  collectEnvReads,
  envNamesInExample,
  envReadsInPydanticSettings,
  envReadsInShell,
  envReadsInSource,
  isCredentialShaped,
  isShippedSource,
  readmeBypassNames,
} from "./check-bypass-credentials.mjs";

const README = `# Willder

${README_HEADING}

Prose that names \`NOT_IN_TABLE_KEY\` outside the table.

| Credential | What it reaches | Read by |
|---|---|---|
| \`DATABASE_URL\`, \`DATABASE_URL_UNPOOLED\` | Every table. | \`lib/db.ts\` |
| \`NEO4J_PASSWORD\` | The graph. | \`memory-service/app/config.py\` |

## Next section

| \`LATER_SECRET\` | not part of the list | x |
`;

const found = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe("isCredentialShaped", () => {
  it("accepts secrets and store addresses", () => {
    for (const name of [
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "NEO4J_URI",
      "NEO4J_USERNAME",
      "NEO4J_PASSWORD",
      "GRAPHITI_SERVICE_API_KEY",
      "BLOB_READ_WRITE_TOKEN",
      "CLERK_WEBHOOK_SECRET",
      "SENTRY_DSN",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]) {
      expect(isCredentialShaped(name), name).toBe(true);
    }
  });

  it("rejects flags, ids, and anything compiled into the browser bundle", () => {
    for (const name of [
      "NODE_ENV",
      "INNGEST_BYPASS",
      "VERCEL_PROJECT_ID",
      "GRAPHITI_TIMEOUT_MS",
      "NEXT_PUBLIC_GOOGLE_API_KEY",
      "NEXT_PUBLIC_APP_URL",
      "MONKEYS",
    ]) {
      expect(isCredentialShaped(name), name).toBe(false);
    }
  });
});

describe("reading environment variable names from source", () => {
  it("finds process.env reads in both spellings", () => {
    const text = `const a = process.env.DATABASE_URL; const b = process.env["NEO4J_URI"]; process.env.lower;`;
    expect([...envReadsInSource(text)].sort()).toEqual(["DATABASE_URL", "NEO4J_URI"]);
  });

  it("finds Python os.environ and os.getenv reads", () => {
    const text = `a = os.environ["A_KEY"]\nb = os.environ.get("B_TOKEN")\nc = os.getenv('C_SECRET')`;
    expect([...envReadsInSource(text)].sort()).toEqual(["A_KEY", "B_TOKEN", "C_SECRET"]);
  });

  it("finds env.NAME reads on an env object passed in place of process.env", () => {
    const text = `function f(env = process.env) { return env.WILLDER_TOKEN?.trim() ?? env["OTHER_KEY"]; }`;
    expect([...envReadsInSource(text)].sort()).toEqual(["OTHER_KEY", "WILLDER_TOKEN"]);
  });

  it("finds names destructured from process.env, including renamed and defaulted ones", () => {
    const text = [
      "const { DATABASE_URL, NEO4J_PASSWORD: password, BLOB_TOKEN = '' } = process.env;",
      "const { SESSION_SECRET } = env;",
      "const { notEnv } = config;",
    ].join("\n");
    expect([...envReadsInSource(text)].sort()).toEqual([
      "BLOB_TOKEN",
      "DATABASE_URL",
      "NEO4J_PASSWORD",
      "SESSION_SECRET",
    ]);
  });

  it("counts a credential-shaped string literal as a read, since process.env[name] cannot be followed", () => {
    const text = [
      'const PROVIDERS = { slack: { clientIdEnv: "SLACK_CLIENT_ID", clientSecretEnv: "SLACK_CLIENT_SECRET" } };',
      "const other = 'FIGMA_CLIENT_SECRET';",
      'const label = "NODE_ENV"; const sentence = "MISSING_TOKEN is unset";',
      "// a comment that mentions `APP_ENCRYPTION_KEY`",
      "const secret = process.env[clientSecretEnv];",
    ].join("\n");
    expect([...envReadsInSource(text)].sort()).toEqual(["FIGMA_CLIENT_SECRET", "SLACK_CLIENT_SECRET"]);
  });

  it("maps pydantic BaseSettings fields to upper-snake names, and only inside that class", () => {
    const text = [
      "class Settings(BaseSettings):",
      "    model_config = SettingsConfigDict(env_file='.env')",
      "    neo4j_password: str = ''",
      "    blob_read_write_token: str = ''  # comment",
      "",
      "    @field_validator('x')",
      "    def check(cls, v: str) -> str:",
      "        local_name: str = v",
      "class Other:",
      "    not_a_setting: str = ''",
    ].join("\n");
    expect([...envReadsInPydanticSettings(text)].sort()).toEqual(["BLOB_READ_WRITE_TOKEN", "NEO4J_PASSWORD"]);
  });

  it("counts a shell expansion as a read unless the script assigns the name itself", () => {
    const text = [
      'DB_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"',
      'if output=$(DATABASE_URL="$DB_URL" npx prisma migrate deploy); then',
      '  export LOCAL_TOKEN=1; echo "$LOCAL_TOKEN"',
      "fi",
    ].join("\n");
    expect([...envReadsInShell(text)].sort()).toEqual(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
  });

  it("reads assigned and commented-out names from .env.example", () => {
    const text = "DATABASE_URL=\n# WILLDER_CAPABILITY_TOKEN=  # optional\nNOT A NAME\n  # prose = here\n";
    expect([...envNamesInExample(text)].sort()).toEqual(["DATABASE_URL", "WILLDER_CAPABILITY_TOKEN"]);
  });
});

describe("isShippedSource", () => {
  it("keeps product code and drops tests, operator scripts and tooling", () => {
    expect(isShippedSource("services/agents/qa-sandbox.ts")).toBe(true);
    expect(isShippedSource("memory-service/app/config.py")).toBe(true);
    expect(isShippedSource("build.sh")).toBe(true);
    expect(isShippedSource("services/access/check.test.ts")).toBe(false);
    expect(isShippedSource("memory-service/tests/test_main.py")).toBe(false);
    expect(isShippedSource("scripts/dev-token.ts")).toBe(false);
    expect(isShippedSource(".agents/skills/x/scripts/run.sh")).toBe(false);
    expect(isShippedSource("README.md")).toBe(false);
  });
});

describe("readmeBypassNames", () => {
  it("reads first-column names from the section's table only", () => {
    expect([...readmeBypassNames(README)].sort()).toEqual(["DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEO4J_PASSWORD"]);
  });

  it("refuses a README without the section or with an empty table", () => {
    expect(() => readmeBypassNames("# Willder\n")).toThrow(README_HEADING);
    expect(() => readmeBypassNames(`${README_HEADING}\n\nNo table.\n`)).toThrow("lists no credentials");
  });
});

describe("classify", () => {
  const readme = new Set(["DATABASE_URL", "NEO4J_PASSWORD"]);
  const notABypass = { STRIPE_SECRET_KEY: "billing only" };

  it("passes when every credential is classified once and every entry is read", () => {
    const reads = found({
      DATABASE_URL: ["lib/db.ts"],
      NEO4J_PASSWORD: [".env.example"],
      STRIPE_SECRET_KEY: ["services/billing.ts"],
      NODE_ENV: ["lib/x.ts"],
    });
    expect(classify({ found: reads, readme, notABypass })).toEqual([]);
  });

  it("fails on a credential the code reads that is in neither list, naming the file", () => {
    const reads = found({
      DATABASE_URL: ["lib/db.ts"],
      NEO4J_PASSWORD: ["a.py"],
      STRIPE_SECRET_KEY: ["b.ts"],
      NEW_STORE_TOKEN: ["services/new.ts"],
    });
    const findings = classify({ found: reads, readme, notABypass });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("NEW_STORE_TOKEN (read in services/new.ts)");
  });

  it("fails on a README entry nothing reads any more", () => {
    const reads = found({
      DATABASE_URL: ["lib/db.ts"],
      STRIPE_SECRET_KEY: ["b.ts"],
    });
    const findings = classify({ found: reads, readme, notABypass });
    expect(findings).toEqual([expect.stringContaining("NEO4J_PASSWORD is in the README's bypass list, but no")]);
  });

  it("fails on a NOT_A_BYPASS entry nothing reads any more", () => {
    const reads = found({
      DATABASE_URL: ["lib/db.ts"],
      NEO4J_PASSWORD: ["a.py"],
    });
    const findings = classify({ found: reads, readme, notABypass });
    expect(findings).toEqual([expect.stringContaining("STRIPE_SECRET_KEY is in NOT_A_BYPASS, but nothing reads it")]);
  });

  it("fails on a name given both answers", () => {
    const reads = found({
      DATABASE_URL: ["lib/db.ts"],
      NEO4J_PASSWORD: ["a.py"],
      STRIPE_SECRET_KEY: ["b.ts"],
    });
    const findings = classify({
      found: reads,
      readme,
      notABypass: { ...notABypass, DATABASE_URL: "wrong" },
    });
    expect(findings).toEqual([
      expect.stringContaining("DATABASE_URL is in the README's bypass list and also in NOT_A_BYPASS"),
    ]);
  });
});

describe("this repository", () => {
  const root = path.resolve(__dirname, "..");
  const readmeText = readFileSync(path.join(root, "README.md"), "utf8");
  const reads = collectEnvReads(root);

  it("has a README bypass list that matches the code", () => {
    expect(classify({ found: reads, readme: readmeBypassNames(readmeText) })).toEqual([]);
  });

  it("fails once a credential the code reads is dropped from the README table", () => {
    const row = readmeText.split("\n").find((line) => line.startsWith("| `VERCEL_TOKEN`"));
    expect(row).toBeDefined();
    const without = readmeText.replace(`${row}\n`, "");
    const findings = classify({
      found: reads,
      readme: readmeBypassNames(without),
    });
    expect(findings).toEqual([expect.stringContaining("VERCEL_TOKEN (read in services/agents/qa-sandbox.ts")]);
  });

  it("reads connector secrets named in a table and read through process.env[name]", () => {
    for (const name of ["SLACK_CLIENT_SECRET", "FIGMA_CLIENT_SECRET"]) {
      expect(reads.get(name), name).toContain("services/integrations/connector-oauth.ts");
    }
  });

  it("reads the agent hook's token off the env object it is given", () => {
    expect(reads.get("WILLDER_TOKEN")).toContain("cli/hooks/willder-changes.mjs");
  });

  it("reads the credentials an SDK reads implicitly, through .env.example", () => {
    expect(reads.get("INNGEST_SIGNING_KEY")).toEqual([".env.example"]);
  });

  it("reads the memory service's settings from its pydantic class, not only from .env.example", () => {
    expect(reads.get("NEO4J_PASSWORD")).toContain("memory-service/app/config.py");
  });
});
