import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// "@/*" -> repo root, matching tsconfig paths so tests import the same way the app does.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // Two projects instead of one global environment: the existing
    // suite is *.test.ts under environment "node" (fast, no DOM), and a new
    // "component" project runs *.test.tsx under jsdom so real client-side
    // rendering bugs (upload-button.tsx's FormData scope-append, graph-
    // explorer.tsx's wheel-zoom attach) are visible to CI instead of only
    // ever caught by a throwaway manual harness. `extends: true` inherits
    // this file's resolve.alias so both projects import the same way the
    // app does.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          // One template database per run, one copy of it per worker, so no
          // two workers share a database (tests/setup/test-databases.ts).
          // Without QA_DATABASE_URL both are no-ops. Only this project holds
          // database suites; the component project needs neither.
          // Each run also gets its own TMPDIR, removed when it ends, so the
          // scratch directories tests make never pile up (tests/setup/run-tmpdir.ts).
          globalSetup: ["./tests/setup/global-tmpdir.ts", "./tests/setup/global-database.ts"],
          setupFiles: ["./tests/setup/worker-database.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["**/*.test.tsx"],
          // Ceilings for a hung test, not speed claims; see vitest.setup.component.ts.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          globalSetup: ["./tests/setup/global-tmpdir.ts"],
          setupFiles: ["./vitest.setup.component.ts"],
        },
      },
    ],
  },
});
