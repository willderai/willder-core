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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  scopeContainmentGate,
  blobAccessGate,
  auditWriterGate,
  memoryAccessGate,
  sqlUtcNowGate,
  refusalGate,
  lookupGate,
  {
    rules: {
      // The codebase's established convention for an intentionally-unused
      // binding (a required callback param, a destructured field kept only
      // for documentation) is a leading underscore, e.g. `_input`, `_req`,
      // `_drop`. Recognize it instead of flagging every site individually.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
