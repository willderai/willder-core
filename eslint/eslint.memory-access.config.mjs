// The config CI runs the memory-access gate with (`npm run scope-gate:check`).
//
// It loads that one rule and ignores every inline config comment in the linted
// files (`noInlineConfig`), so no `eslint-disable` comment, named or blanket, can
// switch the gate off for a line or a file. A path that must query a memory table
// does it inside the authorizer's own modules; see eslint.memory-access.mjs.
//
// The rule is also loaded by eslint.config.mjs and eslint.scope-gate.config.mjs,
// which honor inline comments for their other rules. This config is what makes
// the memory-access rule impossible to silence from the file it reports on.
import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";
import { memoryAccessGate } from "./eslint.memory-access.mjs";

// The TypeScript parser alone, without eslint-config-next's rules.
const tsParserOnly = nextTs.find((c) => c.name === "typescript-eslint/base");

export default defineConfig([
  tsParserOnly,
  memoryAccessGate,
  { linterOptions: { noInlineConfig: true } },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
