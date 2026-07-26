import { describe, expect, it } from 'vitest'
import { buildFixPrompt, extractFixMarkers } from './fix-prompt'
import { insightId } from './detector'

describe('buildFixPrompt', () => {
  it('produces marker → diagnosis → excerpts → task → done-when, round-trippable', () => {
    const id = insightId('repeated-nudges', 'tuneloop', 'deploy-sequence')
    const prompt = buildFixPrompt({
      id,
      diagnosis: 'Across 6 recent sessions, the user had to re-explain the staging deploy sequence.',
      excerpts: ['Jun 30: "no — deploy to staging first with --no-invoker-iam-check"', 'Jul 2: "build with the prod env file first"'],
      task: 'Add a "Deploying" section to CLAUDE.md capturing the full staging deploy sequence.',
      doneWhen: 'A fresh session asked "deploy this to staging" states the correct sequence from CLAUDE.md alone.',
    })
    expect(prompt.startsWith(`tuneloop-fix: ${id}\n`)).toBe(true)
    expect(prompt).toContain('- Jun 30:')
    expect(prompt).toContain('Task: Add a "Deploying" section')
    expect(prompt).toContain('Done when: A fresh session')
    expect(extractFixMarkers(prompt)).toEqual([id]) // what we build, we can sight
  })
})

describe('extractFixMarkers', () => {
  it('finds multiple markers, case-insensitively, and rejects wrong-length ids', () => {
    const text = 'tuneloop-fix: aaaaaaaaaaaaaaaa\nsome text\nTUNELOOP-FIX: BBBBBBBBBBBBBBBB\ntuneloop-fix: tooshort\ntuneloop-fix: aaaaaaaaaaaaaaaaaaaa'
    expect(extractFixMarkers(text)).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
  })

  it('returns empty for text without markers', () => {
    expect(extractFixMarkers('fix this bug please')).toEqual([])
  })
})
