import { describe, expect, it } from 'vitest'
import { stripInertRegions } from './outcomes-git'

const GH = /\bgh\s+pr\s+(?:create|merge)\b/
const COMMIT = /\bgit\b[^\n]*\bcommit\b/

describe('stripInertRegions', () => {
  it('drops a heredoc body written to a file (the fixture false positive)', () => {
    // A `cat >> test.py` heredoc whose body embeds a mock transcript containing
    // `gh pr create`, `git commit`, and a PR URL — none of it is executed.
    const cmd = [
      "cat >> tests/test_processing.py << 'EOF'",
      '        {"command": "gh pr create --title \'Add a.py\'"},',
      '        {"command": "git commit -m x"},',
      '        {"type": "tool_result", "content": "https://github.com/acme/x/pull/42"},',
      'EOF',
    ].join('\n')
    const exec = stripInertRegions(cmd)
    expect(GH.test(exec)).toBe(false)
    expect(COMMIT.test(exec)).toBe(false)
    expect(exec).not.toContain('acme/x/pull/42')
  })

  it('keeps a real gh pr create, including chained and cd-prefixed forms', () => {
    expect(GH.test(stripInertRegions('gh pr create --base main --title "x"'))).toBe(true)
    expect(GH.test(stripInertRegions('git push && gh pr create --fill'))).toBe(true)
    expect(GH.test(stripInertRegions('cd repo\ngh pr create --head feat'))).toBe(true)
  })

  it('keeps gh pr merge with the URL as an argument', () => {
    const exec = stripInertRegions('gh pr merge https://github.com/acme/x/pull/42 --squash')
    expect(GH.test(exec)).toBe(true)
    expect(exec).toContain('acme/x/pull/42')
  })

  it('keeps a heredoc body when the sink executes it (bash <<EOF)', () => {
    const cmd = ["bash <<'EOF'", 'gh pr create --fill', 'EOF'].join('\n')
    expect(GH.test(stripInertRegions(cmd))).toBe(true)
  })

  it('does not let a quoted PR string in a non-gh command count as activity', () => {
    const exec = stripInertRegions('echo "gh pr create — see https://github.com/acme/x/pull/42"')
    expect(GH.test(exec)).toBe(false)
    expect(exec).not.toContain('acme/x/pull/42')
  })

  it('keeps a real gh pr create even when its --body uses an inert heredoc', () => {
    const cmd = ["gh pr create --title x --body-file - <<'EOF'", 'gh pr create (mentioned in body)', 'EOF'].join('\n')
    const exec = stripInertRegions(cmd)
    expect(GH.test(exec)).toBe(true) // matched on the introducing line, body dropped
  })
})
