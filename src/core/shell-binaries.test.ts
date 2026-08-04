import { describe, expect, it } from 'vitest'
import { shellBinaries } from './shell-binaries'

describe('shellBinaries — segmentation', () => {
  it('takes the first word of a plain command', () => {
    expect(shellBinaries('git status')).toEqual(['git'])
  })

  it('splits a chain on &&, ||, ; and |', () => {
    expect(shellBinaries('npm run build && npm test')).toEqual(['npm'])
    expect(shellBinaries('pytest || echo failed')).toEqual(['pytest', 'echo'])
    expect(shellBinaries('git fetch; gh pr list')).toEqual(['git', 'gh'])
    expect(shellBinaries('cat log.txt | grep ERROR | wc -l')).toEqual(['cat', 'grep', 'wc'])
  })

  it('splits on newlines — a multi-line command is a chain', () => {
    expect(shellBinaries('git add -A\nnpm test')).toEqual(['git', 'npm'])
  })

  it('splits on a top-level subshell so `(cd x && make)` reports make', () => {
    expect(shellBinaries('(cd sub && make build)')).toEqual(['make'])
  })

  it('de-duplicates, keeping first-appearance order', () => {
    expect(shellBinaries('git add -A && git commit -m wip && git push')).toEqual(['git'])
    expect(shellBinaries('npm ci && git status && npm test')).toEqual(['npm', 'git'])
  })
})

describe('shellBinaries — quoting', () => {
  it('does not split on separators inside quotes', () => {
    expect(shellBinaries('echo "a && b"')).toEqual(['echo'])
    expect(shellBinaries("grep -r 'foo|bar' src")).toEqual(['grep'])
    expect(shellBinaries('git commit -m "fix; ship it"')).toEqual(['git'])
  })

  it('does not split on separators inside command substitution', () => {
    expect(shellBinaries('echo $(ls | wc -l) && git status')).toEqual(['echo', 'git'])
    expect(shellBinaries('echo `date | tr -d :`')).toEqual(['echo'])
  })

  it('skips heredoc bodies — their lines are data, not commands', () => {
    expect(shellBinaries("python3 - <<'EOF'\nimport os\nprint(os.getcwd())\nEOF")).toEqual(['python3'])
    expect(shellBinaries('cat <<EOF > note.txt\ngit push --force\nEOF\ngit status')).toEqual(['cat', 'git'])
  })

  it('honours a backslash-escaped separator', () => {
    expect(shellBinaries('echo a \\| b')).toEqual(['echo'])
  })
})

// Shapes that only showed up when the parser was run over a real store's shell
// commands — each one had been producing a phantom binary.
describe('shellBinaries — shapes from real transcripts', () => {
  it('keeps a nested command substitution from ending the outer double quote early', () => {
    // The inner `"$DB"` used to close the quote opened after `echo`, spilling the
    // SQL back into the token stream as `SELECT` / `FROM` "binaries".
    expect(shellBinaries('echo "rows: $(sqlite3 "$DB" "SELECT COUNT(*) FROM tool_calls;")"')).toEqual(['echo'])
  })

  it('ignores a comment to end of line', () => {
    expect(shellBinaries('rm -f out.png  # stale build\ngit status')).toEqual(['rm', 'git'])
    expect(shellBinaries('curl http://x/y#frag')).toEqual(['curl']) // a mid-word # is literal
  })

  it('reads through shell control structures without inventing binaries', () => {
    // The loop header names a variable, not a tool; the body still reports its own.
    expect(shellBinaries('for f in a b; do convert "$f" out.png; done')).toEqual(['convert'])
    expect(shellBinaries('for f in a b; do npm run build; done')).toEqual(['npm'])
    expect(shellBinaries('if [ -x /bin/ls ]; then echo yes; fi')).toEqual(['echo'])
    expect(shellBinaries('if npm test; then git push; fi')).toEqual(['npm', 'git'])
  })

  it('yields nothing when the binary is a variable — naming it would be a guess', () => {
    expect(shellBinaries('CHROME="/Applications/Chrome"; "$CHROME" --headless --screenshot')).toEqual([])
    expect(shellBinaries('$(which python3) --version')).toEqual([])
  })

  it('drops punctuation and flags that are not tools', () => {
    expect(shellBinaries('find . -name "*.ts" -exec rm {} \\;')).toEqual(['find'])
  })

  it('does not count a shell function definition as a call', () => {
    expect(shellBinaries('probe() { curl -s "$1"; }; probe http://localhost:4321')).toEqual(['curl', 'probe'])
  })

  it('keeps only the first segment when quoting broke and the "chain" is source code', () => {
    // An apostrophe inside `node -e '…'` closes the quote early, after which the
    // regexes in the script read as pipes. 100+ "binaries" means a mis-parse.
    const src = Array.from({ length: 40 }, (_, k) => `if(/a${k}|b${k}|c${k}/.test(t))return "x${k}"`).join(';')
    expect(shellBinaries(`node -e 'const t = "don'?t"; ${src}'`)).toEqual(['node'])
  })
})

describe('shellBinaries — wrapper and navigation tokens', () => {
  it('drops a navigation-only segment', () => {
    expect(shellBinaries('cd /repo')).toEqual([])
    expect(shellBinaries('cd /repo && npm test')).toEqual(['npm'])
    expect(shellBinaries('export NODE_ENV=test && pytest')).toEqual(['pytest'])
  })

  it('strips VAR=value prefixes', () => {
    expect(shellBinaries('FOO=1 BAR=2 pytest -q')).toEqual(['pytest'])
  })

  it('strips sudo / env / time / timeout wrappers', () => {
    expect(shellBinaries('sudo apt-get update')).toEqual(['apt-get'])
    expect(shellBinaries('env NODE_ENV=test npm run test')).toEqual(['npm'])
    expect(shellBinaries('time make build')).toEqual(['make'])
    expect(shellBinaries('timeout 30 pytest')).toEqual(['pytest'])
  })

  it('steps over a wrapper flag and its value', () => {
    expect(shellBinaries('timeout -k 5 30s pytest tests/')).toEqual(['pytest'])
    expect(shellBinaries('sudo -u deploy ./release.sh')).toEqual(['./release.sh'])
  })

  it('unwraps `sh -c` and parses the inner chain', () => {
    expect(shellBinaries("sh -c 'git fetch && gh pr list'")).toEqual(['git', 'gh'])
    expect(shellBinaries('bash -c "npm test"')).toEqual(['npm'])
  })

  it('yields nothing when a wrapper has no command after it', () => {
    expect(shellBinaries('sudo')).toEqual([])
    expect(shellBinaries('sh -c')).toEqual([])
  })
})

describe('shellBinaries — binary naming', () => {
  it('keeps a project-local script verbatim, path and all', () => {
    expect(shellBinaries('./deploy.sh --prod')).toEqual(['./deploy.sh'])
    expect(shellBinaries('scripts/gen.ts')).toEqual(['scripts/gen.ts'])
  })

  it('reduces an absolute or home-relative path to its basename', () => {
    expect(shellBinaries('/usr/local/bin/python3 -m pytest')).toEqual(['python3'])
    expect(shellBinaries('~/bin/lint src')).toEqual(['lint'])
  })

  it('returns nothing for an empty or separator-only command', () => {
    expect(shellBinaries('')).toEqual([])
    expect(shellBinaries('   \n  ')).toEqual([])
    expect(shellBinaries('&& ||')).toEqual([])
  })
})
