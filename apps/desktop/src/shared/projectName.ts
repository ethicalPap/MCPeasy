// Project/server name slugging, shared by BOTH library backends: the
// filesystem one in main (desktop) and the localStorage one in the renderer
// (plain-browser dev mode). One rule set — if the backends validated names
// differently, a project created in one mode could be unopenable in the other.

/** Filesystem-safe slug. Windows is the strictest target (reserved chars,
 * trailing dots/spaces), so its rules apply everywhere for portability. */
export function slugify(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

export interface ProjectValidationError {
  error: string;
}

/** Reject names that slug to nothing (e.g. "..." or only reserved chars) —
 * otherwise createProject would silently make a folder named "". */
export function validateProjectName(name: unknown): string | ProjectValidationError {
  if (typeof name !== "string") return { error: "project name must be a string" };
  const slug = slugify(name);
  if (slug.length === 0) return { error: "project name needs at least one usable character" };
  return slug;
}
