// Theme identity, shared by extraction (index) and orphan-reconcile (merge) so
// the id scheme lives in exactly one place.

export const DETECTOR = 'recurring-themes'

/** Max characters for a theme label — enforced everywhere a label is written (mint, retitle). */
export const MAX_LABEL_CHARS = 80

// The slug bound must be >= MAX_LABEL_CHARS: a theme id embeds slug(label), so a
// shorter bound would drop label-distinguishing characters and collapse two
// distinct (clamped) labels onto the same id.
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_LABEL_CHARS) || 'untitled'
}

/** Trim a label to MAX_LABEL_CHARS; the single place the length bound lives. */
export function clampLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS).trim() : label
}

// Tokens the model sometimes emits in place of a real title — most often when asked to
// name a cluster it fused in the reconcile pass. Matched on the label reduced to bare
// alphanumerics (so "TBD", "N/A", "Placeholder." all normalize in), never as a substring.
const JUNK_LABELS = new Set(['placeholder', 'untitled', 'unknown', 'todo', 'tbd', 'na', 'none', 'theme', 'newtheme', 'new', 'notitle'])

/**
 * A model-proposed theme label is junk when it's empty or a bare placeholder token — reject
 * it so it never mints a "placeholder" theme (extraction) or overwrites a real label (merge
 * reword). Guards the full label, not a substring, so real titles like "New PR Flow" survive.
 */
export function isJunkLabel(label: string): boolean {
  const norm = label.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return norm.length === 0 || JUNK_LABELS.has(norm)
}

/**
 * A theme's stable id. Global by default; repo-scoped only when the gap is
 * inherent to a project (`projectSpecific` AND a repo to scope it to).
 */
export function themeId(label: string, repo: string | null, projectSpecific: boolean): string {
  const scope = projectSpecific && repo ? slug(repo) : 'global'
  return `${DETECTOR}:${scope}:${slug(label)}`
}
