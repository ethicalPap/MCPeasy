export interface ElectronPreflightOptions {
  electronDirectory?: string;
  explicitPath?: string;
  install?: (electronDirectory: string) => void | Promise<void>;
}

export interface ElectronPreflightResult {
  executablePath: string;
  repaired: boolean;
}

export function findElectronExecutable(electronDirectory: string, explicitPath?: string): Promise<string | null>;
export function runElectronInstaller(electronDirectory: string): void;
export function ensureElectronInstalled(options?: ElectronPreflightOptions): Promise<ElectronPreflightResult>;
