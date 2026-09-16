import type { ThemePreference } from "../../shared/ipc";

export const THEME_STORAGE_KEY = "mcpeasy.theme";

/** Unknown or stale persisted values must fall back to the OS instead of
 * stranding the UI in a theme the current build no longer understands. */
export function parseThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): "light" | "dark" {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}

export function readThemePreference(storage?: Pick<Storage, "getItem">): ThemePreference {
  return parseThemePreference((storage ?? window.localStorage).getItem(THEME_STORAGE_KEY));
}

export function applyThemePreference(
  preference: ThemePreference,
  target?: HTMLElement,
  systemIsDark?: boolean,
): void {
  const destination = target ?? document.documentElement;
  const dark = systemIsDark ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(preference, dark);
  destination.dataset.theme = resolved;
  destination.style.colorScheme = resolved;
}
