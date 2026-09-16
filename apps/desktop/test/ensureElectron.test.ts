import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureElectronInstalled, findElectronExecutable } from "../scripts/ensure-electron.mjs";

const temporaryDirectories: string[] = [];

async function temporaryElectronDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcpeasy-electron-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Electron runtime preflight", () => {
  it("accepts a complete existing runtime without invoking the installer", async () => {
    const directory = await temporaryElectronDirectory();
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "path.txt"), "electron.exe");
    await writeFile(join(directory, "dist", "electron.exe"), "test executable");
    const install = vi.fn();

    const result = await ensureElectronInstalled({ electronDirectory: directory, install });

    expect(result).toEqual({ executablePath: join(directory, "dist", "electron.exe"), repaired: false });
    expect(install).not.toHaveBeenCalled();
  });

  it("repairs the missing runtime with Electron's installer", async () => {
    const directory = await temporaryElectronDirectory();
    const install = vi.fn(async () => {
      await mkdir(join(directory, "dist"));
      await writeFile(join(directory, "path.txt"), "electron.exe");
      await writeFile(join(directory, "dist", "electron.exe"), "test executable");
    });

    const result = await ensureElectronInstalled({ electronDirectory: directory, install });

    expect(result).toEqual({ executablePath: join(directory, "dist", "electron.exe"), repaired: true });
    expect(install).toHaveBeenCalledOnce();
  });

  it("fails when an explicit custom executable is missing instead of replacing it", async () => {
    const directory = await temporaryElectronDirectory();
    const explicitPath = join(directory, "custom-electron.exe");
    const install = vi.fn();

    await expect(ensureElectronInstalled({ electronDirectory: directory, explicitPath, install })).rejects.toThrow(
      `ELECTRON_EXEC_PATH does not exist: ${explicitPath}`,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects a successful installer that leaves no usable runtime", async () => {
    const directory = await temporaryElectronDirectory();

    await expect(ensureElectronInstalled({ electronDirectory: directory, install: vi.fn() })).rejects.toThrow(
      "Electron's installer completed without creating path.txt and the runtime executable.",
    );
  });

  it("treats a stale path marker as an incomplete runtime", async () => {
    const directory = await temporaryElectronDirectory();
    await writeFile(join(directory, "path.txt"), "electron.exe");

    await expect(findElectronExecutable(directory)).resolves.toBeNull();
  });
});
