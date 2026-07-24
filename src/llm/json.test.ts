import { describe, expect, it } from 'vitest'
import { sanitizeToolInput, stripToolCallLeak } from './json'

describe('stripToolCallLeak', () => {
  // The exact shape observed in real Sonnet-5 draft_fix output: the multi-line
  // `content` value captured its own closing tag plus the sibling `reason` param.
  const leaked =
    'Diagnosis: the agent proposes git ops on stale state.\n' +
    'Done when: it checks state before acting, instead of proceeding on assumed context.' +
    '</content>\n<parameter name="reason">Clear recurring gap (4 occurrences) with a concrete fix.'
  const clean =
    'Diagnosis: the agent proposes git ops on stale state.\n' +
    'Done when: it checks state before acting, instead of proceeding on assumed context.'

  it('strips a leaked </field> + <parameter> tail, keyed by field name', () => {
    expect(stripToolCallLeak(leaked, 'content')).toBe(clean)
  })

  it('strips a trailing orphan </field> tag even without a following <parameter>', () => {
    expect(stripToolCallLeak(`${clean}</content>`, 'content')).toBe(clean)
    expect(stripToolCallLeak(`${clean}</content>\n`, 'content')).toBe(clean)
  })

  it('strips a bare <parameter name="…"> tail when no orphan close precedes it', () => {
    expect(stripToolCallLeak(`${clean}\n<parameter name="reason">why</parameter>`, 'content')).toBe(clean)
  })

  it('strips <invoke>/<function_calls> leakage too', () => {
    expect(stripToolCallLeak(`${clean}\n</invoke>`, 'content')).toBe(clean)
    expect(stripToolCallLeak(`${clean}<function_calls>`, 'content')).toBe(clean)
  })

  it('is a no-op on clean content', () => {
    expect(stripToolCallLeak(clean, 'content')).toBe(clean)
    expect(stripToolCallLeak('', 'content')).toBe('')
  })

  it('preserves legitimate XML/HTML that is not a function-call token', () => {
    const cfg = 'Add this to settings:\n<div class="x">example</div>\nDone.'
    expect(stripToolCallLeak(cfg, 'content')).toBe(cfg)
    // a config snippet that genuinely ends in a closing tag unrelated to its key
    const snippet = 'Wrap it:\n<section>body</section>'
    expect(stripToolCallLeak(snippet, 'content')).toBe(snippet)
  })

  it('works without a key (only the function-call token anchors the cut)', () => {
    expect(stripToolCallLeak(`${clean}<parameter name="reason">why`)).toBe(clean)
  })
})

describe('sanitizeToolInput', () => {
  it('cleans leaked string params in place and leaves non-strings and clean fields untouched', () => {
    const input = {
      worth_surfacing: true,
      fix_type: 'fix-prompt',
      content: 'Do the thing.</content>\n<parameter name="reason">because</parameter>',
      reason: 'because',
      count: 4,
    }
    expect(sanitizeToolInput(input)).toEqual({
      worth_surfacing: true,
      fix_type: 'fix-prompt',
      content: 'Do the thing.',
      reason: 'because',
      count: 4,
    })
  })

  it('is a no-op when nothing leaked', () => {
    const input = { content: 'clean prose', events: '[]' }
    expect(sanitizeToolInput(input)).toEqual({ content: 'clean prose', events: '[]' })
  })
})
