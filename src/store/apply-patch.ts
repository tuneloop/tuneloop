import type { FileEdit } from './store'

/** The file-diff fields `parseApplyPatch` derives; the caller stamps ts/turn. */
export type PatchFileEdit = Pick<FileEdit, 'path' | 'op' | 'hunks'>

// Match the per-side caps fileChanges() uses for object-shaped edits, so a Codex
// patch and a Claude/OpenCode edit render with the same window.
const WRITE_CAP = 16000
const EDIT_CAP = 4000
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

/**
 * Parse a Codex `apply_patch` V4A patch — the raw `*** Begin Patch … *** End Patch`
 * text Codex stores as the tool-call input — into one FileEdit per file it touches.
 *
 * Codex differs from Claude Code / OpenCode in two ways the generic object-shaped
 * path in fileChanges() can't handle: the input is patch TEXT (not `{content}` /
 * `{old_string,new_string}`), and a single call bundles MANY files. Left to the
 * object path it collapses to one empty diff — the "5 files, one shown, no content"
 * symptom. Mapping per file:
 *   - `*** Add File:`    → a `write` of the added (`+`) lines.
 *   - `*** Update File:` → `edit` / `multiedit`, one hunk per `@@` section; context
 *      lines go to BOTH sides so the client's line diff re-derives the +/−.
 *   - `*** Delete File:` → an empty `edit` (the patch carries no prior content, so
 *      only the path is surfaced).
 *   - `*** Move to:`     → renames the current file to the new path.
 */
export function parseApplyPatch(patch: string): PatchFileEdit[] {
  const out: PatchFileEdit[] = []
  type Cur = {
    path: string
    mode: 'add' | 'update' | 'delete'
    addLines: string[]
    hunks: Array<{ del: string[]; ins: string[] }>
  }
  let cur: Cur | null = null

  const flush = (): void => {
    if (!cur) return
    if (cur.mode === 'add') {
      out.push({ path: cur.path, op: 'write', hunks: [{ del: '', ins: clip(cur.addLines.join('\n'), WRITE_CAP) }] })
    } else if (cur.mode === 'delete') {
      out.push({ path: cur.path, op: 'edit', hunks: [{ del: '', ins: '' }] })
    } else {
      const hunks = cur.hunks
        .filter((h) => h.del.length || h.ins.length)
        .map((h) => ({ del: clip(h.del.join('\n'), EDIT_CAP), ins: clip(h.ins.join('\n'), EDIT_CAP) }))
      if (hunks.length) out.push({ path: cur.path, op: hunks.length > 1 ? 'multiedit' : 'edit', hunks })
    }
    cur = null
  }

  for (const raw of patch.split('\n')) {
    const add = /^\*\*\* Add File: (.+)$/.exec(raw)
    const upd = /^\*\*\* Update File: (.+)$/.exec(raw)
    const del = /^\*\*\* Delete File: (.+)$/.exec(raw)
    const mov = /^\*\*\* Move to: (.+)$/.exec(raw)
    if (add) {
      flush()
      cur = { path: add[1]!.trim(), mode: 'add', addLines: [], hunks: [] }
      continue
    }
    if (upd) {
      flush()
      cur = { path: upd[1]!.trim(), mode: 'update', addLines: [], hunks: [{ del: [], ins: [] }] }
      continue
    }
    if (del) {
      flush()
      cur = { path: del[1]!.trim(), mode: 'delete', addLines: [], hunks: [] }
      continue
    }
    if (mov) {
      if (cur) cur.path = mov[1]!.trim() // rename → surface the new path
      continue
    }
    if (/^\*\*\* (?:Begin|End) Patch/.test(raw)) continue
    if (!cur) continue

    if (cur.mode === 'add') {
      // Add bodies are all `+` lines; tolerate a stray bare line.
      cur.addLines.push(raw.startsWith('+') ? raw.slice(1) : raw)
      continue
    }
    if (cur.mode === 'update') {
      if (raw.startsWith('@@')) {
        // Section boundary → start a fresh hunk (skip if the current one is empty).
        const last = cur.hunks[cur.hunks.length - 1]!
        if (last.del.length || last.ins.length) cur.hunks.push({ del: [], ins: [] })
        continue
      }
      const h = cur.hunks[cur.hunks.length - 1]!
      const tag = raw[0]
      const body = raw.slice(1)
      if (tag === '+') h.ins.push(body)
      else if (tag === '-') h.del.push(body)
      else h.del.push(body), h.ins.push(body) // ' ' context (and bare/blank lines) → both sides
    }
  }
  flush()
  return out
}
