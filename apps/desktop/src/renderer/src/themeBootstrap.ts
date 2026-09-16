import { applyThemePreference, readThemePreference } from "./theme";

// This module runs before React and its stylesheet entry so a saved dark theme
// is already on <html> when the first styled frame is painted.
applyThemePreference(readThemePreference());
