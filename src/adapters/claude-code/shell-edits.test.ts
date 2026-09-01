import { describe, expect, it } from 'vitest'
import { editsFromCommand } from './shell-edits'

// Every command shape below is taken from a real recorded session in the
// corpus that motivated the feature.
describe('shell-edit parsing tier — editsFromCommand', () => {
  it('heredoc write: the body IS the new file (a Write in costume)', () => {
    const cmd = [
      "cat > src/store/db.ts <<'EOF'",
      "import { openDb } from './open'",
      'export const db = openDb()',
      'EOF',
    ].join('\n')
    expect(editsFromCommand(cmd)).toEqual([
      { path: 'src/store/db.ts', content: "import { openDb } from './open'\nexport const db = openDb()" },
    ])
  })

  it('a redirect to /dev/null is discarded output, not an edit', () => {
    expect(editsFromCommand("cat > /dev/null <<'EOF'\nnoise\nEOF")).toEqual([])
    expect(editsFromCommand("psql -d x >/dev/null <<'SQL'\nSELECT 1;\nSQL")).toEqual([])
  })

  it('heredoc into /tmp is scratch, not an edit', () => {
    const cmd = "cat > /tmp/dbg.mjs <<'EOF'\nconsole.log(1)\nEOF"
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it('python literal replace on one read+written path (an Edit in costume)', () => {
    const cmd = [
      "python3 - <<'PY'",
      "p='packages/store/src/titles.ts'",
      's=open(p).read()', // variable path — NOT extractable; the literal calls below are
      "s=open('packages/store/src/titles.ts').read()",
      's=s.replace("export function safeTitle", "export function saferTitle")',
      "open('packages/store/src/titles.ts','w').write(s)",
      'PY',
    ].join('\n')
    expect(editsFromCommand(cmd)).toEqual([
      {
        path: 'packages/store/src/titles.ts',
        edits: [{ old_string: 'export function safeTitle', new_string: 'export function saferTitle' }],
      },
    ])
  })

  it('python replace with the path in a VARIABLE — the dominant live shape', () => {
    // Measured on the corpus: real scripts write `p='path'` once, then
    // `open(p)` — literal-only matching recovered 1 pair from 22 sessions.
    const cmd = [
      "python3 - <<'PY'",
      "p='packages/store/src/titles.ts'",
      's=open(p).read()',
      's=s.replace("const a = 1", "const a = 2")',
      "open(p,'w').write(s)",
      'PY',
    ].join('\n')
    expect(editsFromCommand(cmd)).toEqual([
      { path: 'packages/store/src/titles.ts', edits: [{ old_string: 'const a = 1', new_string: 'const a = 2' }] },
    ])
  })

  it('python triple-quoted replace carries multi-line strings verbatim', () => {
    const cmd = [
      "python3 - <<'PY'",
      "s=open('a/b.ts').read()",
      's=s.replace("""old line 1',
      'old line 2""", """new line 1',
      'new line 2""")',
      "open('a/b.ts','w').write(s)",
      'PY',
    ].join('\n')
    const [edit] = editsFromCommand(cmd)
    expect(edit!.edits).toEqual([{ old_string: 'old line 1\nold line 2', new_string: 'new line 1\nnew line 2' }])
  })

  it('python escape sequences decode the way python would', () => {
    const cmd = ["s=open('x/y.ts').read()", "s=s.replace('a\\nb', 'c\\td')", "open('x/y.ts','w').write(s)"].join('\n')
    expect(editsFromCommand(cmd)[0]!.edits).toEqual([{ old_string: 'a\nb', new_string: 'c\td' }])
  })

  it('reads file A, writes file B → no line credit (the literals describe A)', () => {
    const cmd = ["python3 - <<'PY'", "s=open('src/a.ts').read()", "s=s.replace('x','y')", "open('src/b.ts','w').write(s)", 'PY'].join('\n')
    const edits = editsFromCommand(cmd)
    // b.ts still earns path-only credit via the write-target fallback.
    expect(edits).toEqual([{ path: 'src/b.ts' }])
  })

  it('sed -i yields path only — a pattern is not the lines it matched', () => {
    const cmd = `sed -i '' 's/#set-admin/#set-teams/g' apps/server/src/client/settings.ts`
    expect(editsFromCommand(cmd)).toEqual([{ path: 'apps/server/src/client/settings.ts' }])
  })

  it('perl -i -pe yields path only', () => {
    const cmd = `perl -i -pe 's/^export const PARSE_VERSION = 3$/export const PARSE_VERSION = 4/' packages/core/src/adapters/cursor/parse.ts`
    expect(editsFromCommand(cmd)).toEqual([{ path: 'packages/core/src/adapters/cursor/parse.ts' }])
  })

  it('a command with no mutating idiom yields nothing', () => {
    expect(editsFromCommand('npx vitest run && git status --porcelain | head')).toEqual([])
    expect(editsFromCommand('grep -rn "replace(" src/ | head')).toEqual([])
  })

  it('computed python edit (no replace literals) still yields the written path', () => {
    const cmd = [
      "python3 - <<'PY'",
      "d=open('packages/core/src/x.ts','rb').read()",
      "open('packages/core/src/x.ts','w').write(processed(d))",
      'PY',
    ].join('\n')
    expect(editsFromCommand(cmd)).toEqual([{ path: 'packages/core/src/x.ts' }])
  })
})


// Junk shapes found by replaying the LIVE corpus — each was wrongly recovered
// as a file before the hardening pass.
describe('shell-edit parsing tier — write-then-delete is scratch', () => {
  it('a file rm-ed after being written earns nothing (throwaway test file)', () => {
    const cmd = "cat > src/__scratch.test.ts <<'EOF'\nit('x', () => {})\nEOF\nnpx vitest run src/__scratch.test.ts; rm -f src/__scratch.test.ts"
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it.each([
    ['./t.ts', 't.ts'],
    ['t.ts', './t.ts'],
    ['src//t.ts', 'src/t.ts'],
    ['src/./t.ts', 'src/t.ts'],
  ])('equivalent path spellings still identify one scratch file: %s → %s', (written, removed) => {
    const cmd = `cat > ${written} <<'EOF'\nx\nEOF\nrm ${removed}`
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it('rm BEFORE the write is a rewrite — credit kept', () => {
    const cmd = "rm -f src/rebuilt.ts\ncat > src/rebuilt.ts <<'EOF'\nfresh\nEOF"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/rebuilt.ts', content: 'fresh' }])
  })

  it('a python-written file rm-ed afterwards earns nothing', () => {
    const cmd = "python3 - <<'PY'\nopen('out.gen.ts','w').write('x')\nPY\nrm out.gen.ts"
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it('rm -r of a directory does not void a file inside it', () => {
    const cmd = "cat > build/kept.ts <<'EOF'\nx\nEOF\nrm -rf build2"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'build/kept.ts', content: 'x' }])
  })

  it('a glob rm does not void a concrete path', () => {
    const cmd = "cat > src/real.ts <<'EOF'\nx\nEOF\nrm -f *.tmp"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/real.ts', content: 'x' }])
  })

  it('an rm inside a WRITTEN script body is content, not a removal', () => {
    const cmd = "cat > scripts/clean.sh <<'EOF'\nrm -f scripts/clean.sh\nEOF"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'scripts/clean.sh', content: 'rm -f scripts/clean.sh' }])
  })
})

describe('shell-edit parsing tier — live-corpus junk rejection', () => {
  it('the word sed inside a quoted python string is not a sed command', () => {
    const cmd = `python3 - <<'PY'\nMUT = re.compile(r"\\bsed\\s+(-[a-zA-Z]*\\s+)*-i\\b|>>\\s*src/")\nprint(MUT)\nPY`
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it("sed's inline script operand is not a file", () => {
    // unquoted script: first non-option operand is the script, files follow
    expect(editsFromCommand('sed -i s/area/weight/ packages/core/src/x.ts')).toEqual([{ path: 'packages/core/src/x.ts' }])
  })

  it('unexpanded $VAR paths are dropped', () => {
    const cmd = "cat > $CLAUDE_JOB_DIR/tmp/hashpw.mjs <<'EOF'\nx\nEOF"
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it('tokens with parens/commas/dollars are never files', () => {
    const cmd = `perl -i -pe 's/a/b/' "open(os.path.join(tdir," 'x,y' $OUT_FILE`
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it('dotfile operands still count — .env is a real file', () => {
    expect(editsFromCommand('sed -i s/x/y/ .env')).toEqual([{ path: '.env' }])
  })
})

// Regression tests from the adversarial review — each was a confirmed bug.
describe('shell-edit review regressions', () => {
  it('sed operands stop at the newline — the next command is not a file list', () => {
    const cmd = "sed -i '' 's/a/b/' src/x.ts\nnpx vitest run src/x.test.ts"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/x.ts' }])
  })

  it('a body line that starts with the marker does not end the heredoc', () => {
    const cmd = "cat > run.sh <<'EOF'\necho hi\nEOF_TESTS=1 npm test\necho done\nEOF"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'run.sh', content: 'echo hi\nEOF_TESTS=1 npm test\necho done' }])
  })

  it('a <<- heredoc with a tab-indented terminator is captured', () => {
    const cmd = 'cat > run.sh <<-EOF\necho hi\n\tEOF'
    expect(editsFromCommand(cmd)).toEqual([{ path: 'run.sh', content: 'echo hi' }])
  })

  it('escape-heavy python strings parse in linear time (was exponential)', () => {
    const evil = "python3 - <<'PY'\ns=open('a/b.ts').read()\ns=s.replace('" + '\\\\'.repeat(50) + ' x'
    const t0 = Date.now()
    editsFromCommand(evil)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

// Second-wave regressions (adversarial re-review) — each reproduced a bug.
describe('shell-edit parsing tier — second-wave regressions', () => {
  it('an example command INSIDE a heredoc body is content, not a command', () => {
    const cmd = "cat > docs/setup.md <<'DOC'\nexample:\ncat > config.ts <<EOF\nexport const x = 1\nEOF\nDOC"
    const edits = editsFromCommand(cmd)
    expect(edits).toHaveLength(1)
    expect(edits[0]!.path).toBe('docs/setup.md')
    expect(edits[0]!.content).toContain('export const x = 1') // as CONTENT of setup.md
  })

  it('a sed line inside a written script is content, not an edit of its target', () => {
    const cmd = "cat > deploy.sh <<'EOF'\n#!/bin/sh\nsed -i '' 's/a/b/' src/real.ts\nEOF"
    expect(editsFromCommand(cmd)).toEqual([
      { path: 'deploy.sh', content: "#!/bin/sh\nsed -i '' 's/a/b/' src/real.ts" },
    ])
  })

  it('concat/committee are not cat/tee — no verbatim content credit', () => {
    // A redirect from ANY binary certainly wrote the file (path-only), but
    // only cat/tee pass the heredoc body through verbatim as its content.
    expect(editsFromCommand("concat > src/x.ts <<'EOF'\nbody\nEOF")).toEqual([{ path: 'src/x.ts' }])
    expect(editsFromCommand("committee src/x.ts <<'EOF'\nbody\nEOF")).toEqual([])
  })

  it('heredoc-first word order recovers: cat <<EOF > file and | tee file', () => {
    expect(editsFromCommand("cat <<'EOF' > src/x.ts\nhello\nEOF")).toEqual([{ path: 'src/x.ts', content: 'hello' }])
    expect(editsFromCommand("cat <<'EOF' | tee src/y.ts\nworld\nEOF")).toEqual([{ path: 'src/y.ts', content: 'world' }])
  })

  it('extensionless heredoc targets count — Dockerfile is a real write', () => {
    expect(editsFromCommand("cat > Dockerfile <<'EOF'\nFROM node:22\nEOF")).toEqual([
      { path: 'Dockerfile', content: 'FROM node:22' },
    ])
  })

  it('an assignment right after another assignment still resolves', () => {
    const cmd = ["python3 - <<'PY'", "a='foo'", "p='src/x.ts'", 's=open(p).read()', "s=s.replace('old','new')", "open(p,'w').write(s)", 'PY'].join('\n')
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/x.ts', edits: [{ old_string: 'old', new_string: 'new' }] }])
  })

  it('hex/unicode escapes decode the way python would', () => {
    const cmd = ["python3 - <<'PY'", "s=open('a/b.ts').read()", "s=s.replace('a\\x20b', 'c\\u0041d')", "open('a/b.ts','w').write(s)", 'PY'].join('\n')
    expect(editsFromCommand(cmd)[0]!.edits).toEqual([{ old_string: 'a b', new_string: 'cAd' }])
  })

})

describe('shell-edit parsing tier — third-wave review regressions', () => {
  it('a <<< herestring is not a heredoc: following commands are never file content', () => {
    const cmd = "cat <<< hello > src/x.ts\necho done\nsed -i s/a/b/ src/y.ts"
    // No heredoc body exists, so nothing fabricates `echo done…` as content;
    // the real sed edit after it survives.
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/y.ts' }])
  })

  it('a quoted "<<EOF" is text, not an opener', () => {
    const cmd = "grep '<<EOF' src/a.ts\nsed -i s/x/y/ src/b.ts"
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/b.ts' }])
  })

  it('non-\\w markers (END-1) are real heredocs — captured AND masked', () => {
    expect(editsFromCommand("cat > src/x.ts <<'END-1'\nbody line\nEND-1")).toEqual([
      { path: 'src/x.ts', content: 'body line' },
    ])
    // …and a docs heredoc with such a marker masks its example script.
    const docs = "cat > docs/notes.md <<'END-1'\ns=open('src/a.ts').read()\ns=s.replace('x','y')\nopen('src/a.ts','w').write(s)\nEND-1"
    expect(editsFromCommand(docs)).toEqual([{ path: 'docs/notes.md', content: expect.stringContaining('replace') }])
  })

  it('an append is an Edit in shape, never a whole-file Write', () => {
    expect(editsFromCommand("cat >> CHANGELOG.md <<'EOF'\n## v2\nEOF")).toEqual([
      { path: 'CHANGELOG.md', edits: [{ old_string: '', new_string: '## v2' }] },
    ])
    expect(editsFromCommand("tee -a CHANGELOG.md <<'EOF'\n## v3\nEOF")).toEqual([
      { path: 'CHANGELOG.md', edits: [{ old_string: '', new_string: '## v3' }] },
    ])
  })

  it("a target FILENAME containing 'python' does not unmask the body", () => {
    const cmd = "cat > docs/python-tips.md <<'EOF'\ns=open('src/a.ts').read()\ns=s.replace('x','y')\nopen('src/a.ts','w').write(s)\nEOF"
    // The body is a doc, not a script: the real write only — no phantom src/a.ts edit.
    expect(editsFromCommand(cmd)).toEqual([{ path: 'docs/python-tips.md', content: expect.stringContaining('replace') }])
  })

  it('perl -Ilib (include flag) is not in-place — a read yields nothing', () => {
    expect(editsFromCommand("perl -Ilib -ne 'print' data.csv")).toEqual([])
  })

  it("perl -i with a program FILE: the program is not an edited target", () => {
    expect(editsFromCommand('perl -i fix.pl data.txt')).toEqual([{ path: 'data.txt' }])
  })

  it('an absolute-path binary still resolves (/usr/bin/sed)', () => {
    expect(editsFromCommand("/usr/bin/sed -i s/a/b/ src/abs.ts")).toEqual([{ path: 'src/abs.ts' }])
  })

  it('a textual MENTION after the rm revives nothing — only writes count', () => {
    const cmd = "cat > t.gen.ts <<'EOF'\nx\nEOF\nrm t.gen.ts\necho 'removed t.gen.ts'"
    expect(editsFromCommand(cmd)).toEqual([])
    const sub = "cat > x.gen.ts <<'EOF'\nx\nEOF\nrm x.gen.ts\ncp other x.gen.ts.bak"
    expect(editsFromCommand(sub)).toEqual([])
  })

  it('a quoted rm sentence is a string, not a removal', () => {
    const cmd = "cat > src/old.ts <<'EOF'\nkeep\nEOF\ngit commit -m \"cleanup: rm src/old.ts no longer needed\""
    expect(editsFromCommand(cmd)).toEqual([{ path: 'src/old.ts', content: 'keep' }])
  })

  it('an rm inside sh -c "…" still voids — the tokenizer unwraps the wrapper', () => {
    const cmd = "cat > src/f.gen.ts <<'EOF'\nx\nEOF\nsh -c \"npx vitest run src/f.gen.ts; rm src/f.gen.ts\""
    expect(editsFromCommand(cmd)).toEqual([])
  })

  it('a python-written file rm-ed after the python segment is still scratch', () => {
    const cmd = "python3 - <<'PY'\nopen('out.gen.ts','w').write('x')\nPY\nrm out.gen.ts"
    expect(editsFromCommand(cmd)).toEqual([])
  })
})
