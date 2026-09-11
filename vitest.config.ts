import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      // `server-only` throws when imported outside a React Server Component
      // graph; tests import server modules directly.
      "server-only": path.resolve(root, "tests/helpers/server-only-stub.ts"),
    },
  },
});
