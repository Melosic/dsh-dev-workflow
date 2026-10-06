import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { checkCommitMessage } from '../src/tools/check-commit-message.js'
import {
  checkDocSync,
  createCheckDocSyncTool,
  listChangedFiles,
} from '../src/tools/check-doc-sync.js'
import { evaluate, fingerprint, summarize } from '../src/checks.js'
import { renderCheck } from '../src/tools/result.js'
import { makeExec, makeFailingGit, makeGit } from './harness.js'

const t = createTranslator('en-US')
const config = Config({})

describe('src/tools/check-commit-message.ts', () => {
  it('rejects an empty message', () => {
    expect(checkCommitMessage({ message: '   ' }, config, t)).toEqual({
      ok: false,
      errors: [t('tool.check_commit_message.error.empty')],
      warnings: [],
    })
  })

  it('rejects a subject with no Conventional Commits type', () => {
    const outcome = checkCommitMessage({ message: 'Add the thing' }, config, t)
    expect(outcome.ok).toBe(false)
    expect(outcome.errors).toEqual([
      t('tool.check_commit_message.error.missing_type'),
      t('tool.check_commit_message.hint.format'),
    ])
  })

  it('rejects a type outside the accepted list', () => {
    const outcome = checkCommitMessage({ message: 'feature: add the thing' }, config, t)
    expect(outcome.ok).toBe(false)
    expect(outcome.errors).toEqual([t('tool.check_commit_message.error.unknown_type')])
  })

  it('accepts every type the specification lists', () => {
    for (const type of [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ]) {
      expect(
        checkCommitMessage({ message: `${type}(cli): something` }, config, t).errors,
        type,
      ).toEqual([])
    }
  })

  it('accepts a well-formed subject with nothing else to say', () => {
    expect(checkCommitMessage({ message: 'feat(cli): add a flag' }, config, t)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    })
  })

  it('warns when the description exceeds the subject budget', () => {
    const long = `feat(cli): ${'a'.repeat(51)}`
    const outcome = checkCommitMessage({ message: long }, config, t)
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings).toContain(
      t('tool.check_commit_message.warn.subject_length', { length: 51, max: 50 }),
    )
  })

  it('measures only the description, not the whole subject line', () => {
    // `feat(a-very-long-scope): ` is 26 characters and must not count towards
    // the 50-character budget, which covers the text after the colon.
    const outcome = checkCommitMessage(
      { message: `feat(${'a'.repeat(60)}): ${'b'.repeat(50)}` },
      config,
      t,
    )
    expect(outcome.warnings).not.toContain(
      t('tool.check_commit_message.warn.subject_length', { length: 76, max: 50 }),
    )
  })

  it('warns about a trailing period', () => {
    const outcome = checkCommitMessage({ message: 'fix(cli): stop crashing.' }, config, t)
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings).toContain(t('tool.check_commit_message.warn.trailing_period'))
  })

  it('requires a BREAKING CHANGE footer behind a bang', () => {
    const outcome = checkCommitMessage({ message: 'feat(cli)!: drop the old flag' }, config, t)
    expect(outcome.ok).toBe(false)
    expect(outcome.errors).toContain(t('tool.check_commit_message.error.breaking_without_footer'))
  })

  it('accepts a bang that explains itself in a footer', () => {
    const outcome = checkCommitMessage(
      { message: 'feat(cli)!: drop the old flag\n\nBREAKING CHANGE: use --new instead' },
      config,
      t,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.errors).toEqual([])
  })

  it('reports the first over-wide body line only', () => {
    const wide = 'w'.repeat(73)
    const outcome = checkCommitMessage({ message: `fix: thing\n\n${wide}\n${wide}` }, config, t)
    const lines = outcome.warnings.filter((line) => line.includes('72'))
    expect(lines).toHaveLength(1)
  })

  it('lets a URL and a table row exceed the body width', () => {
    // The two exemptions are a line that opens with a URL, and a markdown table
    // row — `\S+\s*\|`, i.e. a cell followed by a separator, which is what a
    // row looks like once the leading pipe is written as part of the cell.
    const url = `https://example.com/${'a'.repeat(80)}`
    const row = `column | ${'a'.repeat(80)} |`
    const outcome = checkCommitMessage({ message: `docs: thing\n\n${url}\n${row}` }, config, t)
    expect(outcome.warnings).toEqual([])
  })

  it('still reports a body line that merely starts with a pipe', () => {
    // Leading-pipe tables are not what the exemption matches, so the warning
    // stands: a false negative here would hide a genuinely unwrapped body.
    const outcome = checkCommitMessage(
      { message: `docs: thing\n\n| ${'a'.repeat(80)} |` },
      config,
      t,
    )
    expect(outcome.warnings).toContain(
      t('tool.check_commit_message.warn.body_width', { length: 84, max: 72 }),
    )
  })

  it('warns when a change spans more than one module', () => {
    const outcome = checkCommitMessage(
      { message: 'refactor: split the parser', files: ['src/a.ts', 'tests/a.spec.ts'] },
      config,
      t,
    )
    expect(outcome.warnings).toContain(
      t('tool.check_commit_message.warn.multiple_modules', { modules: 'src, tests' }),
    )
  })

  it('warns when a single-module change names no scope', () => {
    const outcome = checkCommitMessage(
      { message: 'fix: stop crashing', files: ['src/a.ts'] },
      config,
      t,
    )
    expect(outcome.warnings).toContain(
      t('tool.check_commit_message.warn.missing_scope', { module: 'src' }),
    )
  })

  it('stays quiet about scope when the change already names one', () => {
    const outcome = checkCommitMessage(
      { message: 'fix(cli): stop crashing', files: ['src/a.ts'] },
      config,
      t,
    )
    expect(outcome.warnings).not.toContain(
      t('tool.check_commit_message.warn.missing_scope', { module: 'src' }),
    )
  })
})

describe('src/tools/check-doc-sync.ts', () => {
  it('blocks a paired file left behind', () => {
    const outcome = checkDocSync({ files: ['README.md'] }, config, t)
    expect(outcome.ok).toBe(false)
    expect(outcome.errors).toEqual([
      t('tool.check_doc_sync.error.mirror', {
        changed: 'README.md',
        missing: 'README.zh.md',
      }),
    ])
  })

  it('accepts a pair that changed together', () => {
    const outcome = checkDocSync({ files: ['README.md', 'README.zh.md'] }, config, t)
    expect(outcome.ok).toBe(true)
    expect(outcome.errors).toEqual([])
  })

  it('stays quiet when neither half of a pair changed', () => {
    expect(checkDocSync({ files: ['src/a.ts'] }, config, t).errors).toEqual([])
  })

  it('warns about code that arrived with no documentation at all', () => {
    const outcome = checkDocSync({ files: ['src/a.ts'] }, config, t)
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings).toContain(
      t('tool.check_doc_sync.warn.no_document', {
        count: 1,
        example: 'src/a.ts',
        docsDir: 'docs/',
      }),
    )
  })

  it('warns when a code change skips the changelog', () => {
    const outcome = checkDocSync({ files: ['src/a.ts', 'docs/ARCHITECTURE.md'] }, config, t)
    expect(outcome.warnings).toContain(
      t('tool.check_doc_sync.warn.changelog', { changelog: 'CHANGELOG.md' }),
    )
  })

  it('does not treat a document as code', () => {
    const outcome = checkDocSync({ files: ['docs/README.md'] }, config, t)
    expect(outcome.warnings).toEqual([])
  })

  it('reads changed paths from git when the caller passes none', async () => {
    const tool = createCheckDocSyncTool({
      t: () => t,
      config: () => config,
      git: () => makeGit(() => ['src/a.ts']),
    })
    const value = await tool.execute({}, makeExec('git status'))
    expect(value).toMatchObject({ ok: true, errors: [] })
    expect(value.warnings).toHaveLength(2)
  })

  it('reports a git failure instead of pretending the tree is clean', async () => {
    const tool = createCheckDocSyncTool({
      t: () => t,
      config: () => config,
      git: () => makeFailingGit(),
    })
    const value = await tool.execute({}, makeExec('git status'))
    expect(value.ok).toBe(false)
    expect(value.error).toBe(t('error.not_a_git_repository', { detail: 'fatal: nope' }))
  })

  it('parses porcelain status lines, including renames and quoting', async () => {
    const git = {
      cwd: process.cwd(),
      run: async () => ({
        ok: true as const,
        stdout: ' M src/a.ts\nR  old.md -> "new name.md"\n?? "quote\\"d.ts"\n',
      }),
      locate: async () => ({ ok: true as const, path: 'git' }),
    }
    expect(await listChangedFiles(git)).toEqual({
      ok: true,
      files: ['src/a.ts', 'new name.md', 'quote"d.ts'],
    })
  })
})

describe('src/checks.ts', () => {
  it('merges both checks when the message and the paths are known', () => {
    const outcome = evaluate({ message: 'fix(cli): stop crashing', files: ['src/a.ts'] }, config, t)
    expect(outcome.ok).toBe(true)
    expect(outcome.errors).toEqual([])
    expect(outcome.warnings.length).toBeGreaterThan(0)
  })

  it('escalates a missing changelog to blocking for a feat', () => {
    const outcome = evaluate({ message: 'feat(cli): add a flag', files: ['src/a.ts'] }, config, t)
    expect(outcome.ok).toBe(false)
    expect(outcome.errors).toEqual([
      t('tool.check_commit_message.error.changelog_required', { changelog: 'CHANGELOG.md' }),
    ])
    // Replaced rather than repeated: the advisory line is gone.
    expect(outcome.warnings).not.toContain(
      t('tool.check_doc_sync.warn.changelog', { changelog: 'CHANGELOG.md' }),
    )
  })

  it('accepts a feat that does update the changelog', () => {
    const outcome = evaluate(
      { message: 'feat(cli): add a flag', files: ['src/a.ts', 'CHANGELOG.md', 'docs/X.md'] },
      config,
      t,
    )
    expect(outcome.ok).toBe(true)
  })

  it('leaves the changelog rule advisory for a non-feat', () => {
    const outcome = evaluate({ message: 'chore(cli): tidy', files: ['src/a.ts'] }, config, t)
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings).toContain(
      t('tool.check_doc_sync.warn.changelog', { changelog: 'CHANGELOG.md' }),
    )
  })

  it('runs only the rules its input can support', () => {
    expect(evaluate({ message: 'chore: tidy' }, config, t)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    })
    expect(evaluate({ files: [] }, config, t)).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('summarises a passing and a failing outcome', () => {
    expect(summarize({ ok: true, errors: [], warnings: [] }, t)).toBe(
      t('command.toggle.check.clean'),
    )
    expect(summarize({ ok: false, errors: ['boom'], warnings: [] }, t)).toBe('boom')
  })

  it('digests the same value to the same short hash', () => {
    expect(fingerprint('feat: a')).toBe(fingerprint('feat: a'))
    // A fixed vector: the hash only has to be stable and distinguishing, but
    // pinning one output catches a changed basis or prime.
    expect(fingerprint('feat: a')).toBe('2615a516')
    expect(fingerprint('feat: a')).not.toBe(fingerprint('feat: b'))
    expect(fingerprint('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('src/tools/result.ts', () => {
  it('renders the all-clear line when nothing was found', () => {
    expect(
      renderCheck({ ok: true, errors: [], warnings: [] }, t, 'tool.check_doc_sync.ok'),
    ).toEqual([{ type: 'text', text: 'Documentation and code are in sync.' }])
  })

  it('renders an unrun check as its error alone', () => {
    expect(renderCheck({ ok: false, errors: [], warnings: [], error: 'no git' }, t, 'x')).toEqual([
      { type: 'text', text: 'no git' },
    ])
  })

  it('renders warnings before errors, marked', () => {
    expect(renderCheck({ ok: false, errors: ['bad'], warnings: ['hmm'] }, t, 'x')).toEqual([
      { type: 'text', text: '⚠ hmm\n✖ bad' },
    ])
  })
})
