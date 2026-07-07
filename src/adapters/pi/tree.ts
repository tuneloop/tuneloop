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
export function findCanonicalLeaf(entries: TreeEntry[]): string {
  const leaves = findLeaves(entries)
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
  let current = byId.get(leafId)
  while (current) {
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}
