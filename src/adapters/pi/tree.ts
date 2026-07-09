export interface TreeEntry {
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: unknown
}

/** Find all leaf node IDs (entries whose id is never a parentId). */
export function findLeaves(entries: TreeEntry[]): string[] {
  const parentIds = new Set(entries.map((e) => e.parentId).filter(Boolean))
  return entries.filter((e) => !parentIds.has(e.id)).map((e) => e.id)
}

/** Find the canonical leaf: latest timestamp among nodes with no children. */
export function findCanonicalLeaf(entries: TreeEntry[]): string | null {
  const leaves = findLeaves(entries)
  if (leaves.length === 0) return null
  const byId = new Map(entries.map((e) => [e.id, e]))
  let best = leaves[0]!
  for (const id of leaves) {
    if (byId.get(id)!.timestamp > byId.get(best)!.timestamp) best = id
  }
  return best
}

/** Walk from root to a given leaf, returning entries in root→leaf order. */
export function walkToLeaf(entries: TreeEntry[], leafId: string): TreeEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const path: TreeEntry[] = []
  const seen = new Set<string>()
  let current = byId.get(leafId)
  while (current) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

export interface BranchPath {
  leafId: string
  /** Full root→leaf path entries. */
  path: TreeEntry[]
  /** Entry IDs unique to this branch (not shared with any other leaf's path). */
  uniqueIds: Set<string>
}

/**
 * For each leaf, compute the full root→leaf path and identify which entries
 * are unique to that branch. Results sorted by leaf timestamp descending
 * (latest/canonical first).
 */
export function findBranchPaths(entries: TreeEntry[], leafIds: string[]): BranchPath[] {
  const byId = new Map(entries.map((e) => [e.id, e]))

  const branches: Array<{ leafId: string; path: TreeEntry[]; ids: Set<string> }> = []
  for (const leafId of leafIds) {
    const path = walkToLeaf(entries, leafId)
    branches.push({ leafId, path, ids: new Set(path.map((e) => e.id)) })
  }

  // Count how many branches each entry appears on
  const refCount = new Map<string, number>()
  for (const b of branches) {
    for (const id of b.ids) {
      refCount.set(id, (refCount.get(id) ?? 0) + 1)
    }
  }

  // Unique = appears on exactly one branch
  const result: BranchPath[] = branches.map((b) => ({
    leafId: b.leafId,
    path: b.path,
    uniqueIds: new Set([...b.ids].filter((id) => refCount.get(id) === 1)),
  }))

  // Sort by leaf timestamp descending (canonical/latest first)
  result.sort((a, b) => {
    const tsA = byId.get(a.leafId)?.timestamp ?? ''
    const tsB = byId.get(b.leafId)?.timestamp ?? ''
    return tsB.localeCompare(tsA)
  })

  return result
}
