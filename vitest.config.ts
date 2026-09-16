import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Single root config: workspace packages are source-first (their package.json
// exports point at src/*.ts), so vitest transforms everything in place and
// phase 0 needs no build step at all. tsc runs typecheck-only (noEmit).
export default defineConfig({
  resolve: {
    // Root-level tests (tests/golden) import workspace packages without being
    // inside one; alias straight to source so resolution never depends on
    // pnpm's node_modules layout. Mirrors tsconfig.json "paths".
    alias: {
      "@mcpeasy/schema": fileURLToPath(new URL("./packages/schema/src/index.ts", import.meta.url)),
      "@mcpeasy/engine": fileURLToPath(new URL("./packages/engine/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // apps/*/test covers the desktop app's PURE helpers (graph derivation);
    // React components are exercised by the app itself, not unit-tested yet.
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
