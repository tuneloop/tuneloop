// Theme identity, shared by extraction (index) and orphan-reconcile (merge) so
// the id scheme lives in exactly one place.

export const DETECTOR = 'recurring-themes'

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
}

/** Max characters for a theme label — enforced everywhere a label is written (mint, retitle). */
export const MAX_LABEL_CHARS = 80

/** Trim a label to MAX_LABEL_CHARS; the single place the length bound lives. */
export function clampLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS).trim() : label
}

/**
 * A theme's stable id. Global by default; repo-scoped only when the gap is
 * inherent to a project (`projectSpecific` AND a repo to scope it to).
 */
export function themeId(label: string, repo: string | null, projectSpecific: boolean): string {
  const scope = projectSpecific && repo ? slug(repo) : 'global'
  return `${DETECTOR}:${scope}:${slug(label)}`
}
