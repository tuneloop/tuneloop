import { describe, expect, it } from 'vitest'
import { clampLabel, MAX_LABEL_CHARS, slug, themeId } from './ids'

describe('recurring-themes ids', () => {
  it('gives distinct ids to labels that differ only past char 60 (within the label bound)', () => {
    // Two labels identical through char 60 but differing in 61–80. Both survive
    // clampLabel (<= 80), so their ids must stay distinct — the slug bound must not
    // truncate below the label bound.
    const prefix = 'a'.repeat(60)
    const one = clampLabel(`${prefix} needs the database config path spelled out`)
    const two = clampLabel(`${prefix} needs the deployment region spelled out`)
    expect(one.length).toBeLessThanOrEqual(MAX_LABEL_CHARS)
    expect(two.length).toBeLessThanOrEqual(MAX_LABEL_CHARS)
    expect(themeId(one, null, false)).not.toBe(themeId(two, null, false))
  })

  it('slug preserves the full clamped-label length', () => {
    const label = 'x'.repeat(MAX_LABEL_CHARS)
    expect(slug(label).length).toBe(MAX_LABEL_CHARS)
  })
})
