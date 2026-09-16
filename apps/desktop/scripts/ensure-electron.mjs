#!/usr/bin/env node

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const defaultElectronDirectory = dirname(require.resolve("electron"));

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findElectronExecutable(electronDirectory, explicitPath) {
  if (explicitPath) {
    return (await fileExists(explicitPath)) ? explicitPath : null;
  }

  try {
    const executableName = (await readFile(join(electronDirectory, "path.txt"), "utf8")).trim();
    if (!executableName) return null;

    const executablePath = join(electronDirectory, "dist", executableName);
    return (await fileExists(executablePath)) ? executablePath : null;
  } catch {
    return null;
  }
}

export function runElectronInstaller(electronDirectory) {
  // Use Electron's installed downloader rather than duplicating its platform,
  // mirror, proxy, cache, and checksum rules in a second implementation.
  const result = spawnSync(process.execPath, [join(electronDirectory, "install.js")], {
    cwd: electronDirectory,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron's installer exited with code ${result.status ?? "unknown"}.`);
  }
}

export async function ensureElectronInstalled({
  electronDirectory = defaultElectronDirectory,
  explicitPath = process.env.ELECTRON_EXEC_PATH,
  install = runElectronInstaller,
} = {}) {
  const existingExecutable = await findElectronExecutable(electronDirectory, explicitPath);
  if (existingExecutable) return { executablePath: existingExecutable, repaired: false };

  // An explicit executable is an escape hatch for custom runtimes. Never
  // replace that user-owned choice with a downloaded default behind their back.
  if (explicitPath) {
    throw new Error(`ELECTRON_EXEC_PATH does not exist: ${explicitPath}`);
  }

  console.warn("[mcpeasy] Electron's package is present, but its runtime binary is missing; repairing it now...");
  await install(electronDirectory);

  const repairedExecutable = await findElectronExecutable(electronDirectory);
  if (!repairedExecutable) {
    throw new Error("Electron's installer completed without creating path.txt and the runtime executable.");
  }

  return { executablePath: repairedExecutable, repaired: true };
}

async function main() {
  try {
    const result = await ensureElectronInstalled();
    if (result.repaired) console.log("[mcpeasy] Electron runtime repaired successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcpeasy] Electron runtime is unavailable: ${message}`);
    console.error(
      "[mcpeasy] Check access to GitHub Releases (and ELECTRON_GET_USE_PROXY if required), then run pnpm ui again.",
    );
    process.exitCode = 1;
  }
}

// Keep the helpers importable for deterministic tests without making an import
// download a 200+ MB runtime as a side effect.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
