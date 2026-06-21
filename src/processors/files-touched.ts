import { registerProcessor } from '../core/registry'
import type { Processor } from '../core/processor'
import type { ArtifactInput, FileIndexInput, OutcomeInput, SessionArtifactInput } from '../store/types'

/**
 * Static extractor: every file the session wrote becomes a `file` artifact
 * linked to the session (for `search` + linkage), and the session gets one
 * `file_written` outcome (session-level, no artifact). Demonstrates the
 * one-file processor pattern.
 */
export const filesTouched: Processor = {
  name: 'files-touched',
  version: 1,
  kind: 'static',
  run(ctx) {
    const { session } = ctx
    const repoKey = session.project.repo ?? session.project.cwd ?? ''
    const paths = new Set<string>()
    for (const t of session.toolCalls) {
      if (t.action !== 'file_write') continue
      for (const p of t.target.paths ?? []) paths.add(p)
    }
    if (paths.size === 0) return {}

    const artifacts: ArtifactInput[] = []
    const sessionArtifacts: SessionArtifactInput[] = []
    const files: FileIndexInput[] = []
    for (const p of paths) {
      const id = `file:${repoKey}:${p}`
      artifacts.push({ id, kind: 'file', repo: session.project.repo, ident: p, source: 'transcript' })
      sessionArtifacts.push({ artifactId: id, role: 'edited', source: 'explicit' })
      files.push({ repo: session.project.repo, path: p })
    }
    const outcomes: OutcomeInput[] = [{ type: 'file_written', artifactId: null, ts: session.endedAt }]
    return { artifacts, sessionArtifacts, files, outcomes }
  },
}

registerProcessor(filesTouched)
