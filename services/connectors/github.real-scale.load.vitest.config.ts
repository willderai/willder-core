import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The config github.real-scale.load.test.ts runs github.real-scale.test.ts under: the root
// config's node project minus its database setup and its 30 s test limit, plus the slow response
// reader. It sets no limit, so vitest's 5 s default stands: the guard needs that one.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["services/connectors/github.real-scale.test.ts"],
    setupFiles: [fileURLToPath(new URL("./github.real-scale.load-setup.ts", import.meta.url))],
  },
});
