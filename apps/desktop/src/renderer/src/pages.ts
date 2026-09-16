// Page ids in their own tiny module (no JSX) so pure code and tests can name
// pages without importing the sidebar's React components.

export type PageId =
  | "builder"
  | "secrets"
  | "integrations"
  | "repository"
  // "members" is deliberately absent while the Member page is deferred: an id
  // with no PAGES entry would resolve through pageById's fallback and silently
  // render the Builder's metadata. See the commented entry in nav.tsx.
  | "settings"
  | "help";
