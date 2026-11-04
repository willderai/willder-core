import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { scopeContainmentGate } from "./eslint.scope-gate.mjs";
import { blobAccessGate } from "./eslint.blob-access.mjs";
import { auditWriterGate } from "./eslint.audit-writer.mjs";
import { memoryAccessGate } from "./eslint.memory-access.mjs";
import { sqlUtcNowGate } from "./eslint.sql-utc-now.mjs";
import { refusalGate } from "./eslint.refusal-gate.mjs";
import { lookupGate } from "./eslint.lookup-gate.mjs";

// A standalone config carrying
// *only* the scope-containment gate, no next-core-web-vitals/next-typescript
// rules. `npm run lint` (eslint.config.mjs, the full ruleset) can't be a CI
// gate as-is -- it's red on a pre-existing 99-error/45-warning baseline
// unrelated to this rule, so a wholesale `npm run lint` step in CI would
// fail on day one regardless of whether anyone violates this rule.
// This file exists so CI (see .github/workflows/ci.yml's `scope-gate-check`
// job, and `npm run scope-gate:check` to reproduce locally) can gate on
// *new* no-restricted-syntax violations from this one rule without also
// gating on the unrelated baseline. The 4 documented call-site exceptions
// use the same
// `eslint-disable no-restricted-syntax` comments either config reads, so
// they're silent under this narrower config too -- today this reports 0.
//
// Still needs the TypeScript parser (a raw `no-restricted-syntax` config
// with no parser can't even read .ts/.tsx syntax -- confirmed live, it
// throws a parse error on every file), so this pulls just
// `typescript-eslint/base` (parser + plugin registration, zero rules) out
// of eslint-config-next/typescript by name rather than the whole config,
// which is what would drag the 99/45 baseline back in.
const tsParserOnly = nextTs.find((c) => c.name === "typescript-eslint/base");

// Every plugin namespace eslint-config-next registers anywhere (react,
// react-hooks, import, jsx-a11y, @next/next, @typescript-eslint), collected
// without their rule sets. Needed only so a pre-existing
// `eslint-disable(-next-line) <plugin>/<rule>` comment elsewhere in the repo
// resolves as a real, known-but-inactive rule instead of erroring
// "Definition for rule ... was not found" -- confirmed live, that error
// fires even with reportUnusedDisableDirectives off, because it's a
// missing-plugin error, not an unused-directive one. Registering the
// plugins (still zero of their rules turned on) fixes it without pulling
// any of their findings into this gate.
const allPluginsNoRules = Object.assign({}, ...[...nextVitals, ...nextTs].map((c) => c.plugins ?? {}));

export default defineConfig([
  tsParserOnly,
  { files: ["**/*.ts", "**/*.tsx"], plugins: allPluginsNoRules },
  scopeContainmentGate,
  blobAccessGate,
  auditWriterGate,
  memoryAccessGate,
  sqlUtcNowGate,
  refusalGate,
  lookupGate,
  {
    // This config only ever loads one rule (no-restricted-syntax), so a
    // file's disable comment for an unrelated (but now-registered) rule --
    // e.g. an unused @typescript-eslint/no-explicit-any disable -- is not a
    // real finding here, just this config being narrower than
    // eslint.config.mjs by design.
    linterOptions: { reportUnusedDisableDirectives: false },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
