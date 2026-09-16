import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Workspace packages are SOURCE-FIRST (their package.json exports point at
// src/*.ts, phase-0 decision: no build step). That has two consequences here:
// 1. They cannot be externalized in the main-process bundle — an external
//    require("@mcpeasy/engine") would land on a .ts file at runtime. So they
//    are excluded from externalization and bundled from source instead.
// 2. Aliasing straight to the source entry (mirroring vitest.config.ts and
//    tsconfig paths) keeps resolution independent of pnpm's node_modules
//    layout in all three bundles.
const schemaSrc = fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url));
const engineSrc = fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url));

export default defineConfig({
  main: {
    resolve: {
      alias: { "@mcpeasy/schema": schemaSrc, "@mcpeasy/engine": engineSrc },
    },
    // SDK (and its deps) stay external: real published packages resolved from
    // node_modules at runtime, which keeps the main bundle small and avoids
    // bundling Node-flavored transport code.
    plugins: [externalizeDepsPlugin({ exclude: ["@mcpeasy/schema", "@mcpeasy/engine"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // CJS on purpose: an ESM preload (.mjs) requires sandbox:false per
      // Electron's ESM limitations. Bundling to .cjs is what lets the
      // renderer sandbox stay ON (see webPreferences in src/main/index.ts).
      rollupOptions: { output: { format: "cjs" } },
    },
  },
  renderer: {
    // The renderer only ever imports @mcpeasy/schema (pure zod validation +
    // lint). The ENGINE must never be value-imported here: it pulls in the
    // MCP SDK's Node transports, which do not exist in a browser context.
    // Execution requests travel over IPC to the main process instead.
    resolve: {
      alias: { "@mcpeasy/schema": schemaSrc },
    },
    plugins: [react()],
  },
});
