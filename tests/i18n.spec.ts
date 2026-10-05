import en from '../locale/en.json'
import zh from '../locale/zh.json'
import { describe, expect, it } from 'vitest'
import { createTranslator, resolveLocale } from '../src/i18n.js'

// The two shipped dictionaries and the translator built from them. The plugin
// has a second, unrelated i18n mechanism (`locale/*.json` plugin metadata, read
// by the host); this spec covers the translation tables the plugin reads itself.

/**
 * Every leaf path in a dictionary, e.g. `meta.title` and `command.toggle.hint`.
 * @param value - a dictionary or one of its nested objects.
 * @param prefix - the path built so far.
 * @returns the leaf key paths.
 */
function keyPaths(value: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = []
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof entry === 'string') paths.push(path)
    else if (typeof entry === 'object' && entry !== null) {
      paths.push(...keyPaths(entry as Record<string, unknown>, path))
    }
  }
  return paths
}

/**
 * The `{placeholders}` a template carries, sorted.
 * @param template - a dictionary value.
 * @returns the placeholder names.
 */
function placeholders(template: string): string[] {
  return (template.match(/\{(\w+)\}/g) ?? []).map((match) => match.slice(1, -1)).sort()
}

/** Dictionary values that are plain strings, keyed by their leaf path. */
function flat(dictionary: Record<string, unknown>, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const [key, value] of Object.entries(dictionary)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') entries[path] = value
    else if (typeof value === 'object' && value !== null) {
      Object.assign(entries, flat(value as Record<string, unknown>, path))
    }
  }
  return entries
}

/**
 * Whether two sets hold the same members.
 * @param left - one set.
 * @param right - the other set.
 * @returns true when both hold exactly the same members.
 */
function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

describe('src/i18n.ts', () => {
  it('ships the same key set in both dictionaries', () => {
    // The phase-4 acceptance criteria name this assertion literally:
    //
    //   new Set(Object.keys(en)) === new Set(Object.keys(zh))
    //
    // `===` on two distinct Set objects compares identity, so that exact line is
    // false by construction and cannot be the assertion. The statement it means —
    // the two key sets hold the same members — is what is asserted here, with the
    // same two expressions passed to a structural comparison.
    expect(sameSet(new Set(Object.keys(en)), new Set(Object.keys(zh)))).toBe(true)
    expect(new Set(Object.keys(en))).toEqual(new Set(Object.keys(zh)))
    expect([...new Set(Object.keys(en))].sort()).toEqual([...new Set(Object.keys(zh))].sort())
    expect(new Set(Object.keys(en)).size).toBe(61)
  })

  it('ships the same leaf paths in both dictionaries, nesting included', () => {
    // Top-level keys alone would not notice `meta.title` disappearing from one
    // side, because `meta` would still be there on both.
    expect(keyPaths(en).sort()).toEqual(keyPaths(zh).sort())
    expect(keyPaths(en)).toHaveLength(62)
  })

  it('carries the same placeholders in both languages', () => {
    const english = flat(en)
    const chinese = flat(zh)
    for (const [key, template] of Object.entries(english)) {
      expect(placeholders(chinese[key] ?? ''), key).toEqual(placeholders(template))
    }
  })

  it('ships plugin metadata in both languages', () => {
    expect(en.meta).toEqual(
      expect.objectContaining({ title: expect.any(String), description: expect.any(String) }),
    )
    expect(zh.meta.title).not.toBe(en.meta.title)
  })

  it('translates the same key differently per locale', () => {
    const english = createTranslator('en-US')
    const chinese = createTranslator('zh-CN')

    expect(english('tool.check_commit_message.ok')).toBe(
      'The commit message follows Conventional Commits.',
    )
    expect(chinese('tool.check_commit_message.ok')).toBe('提交信息符合 Conventional Commits。')
    expect(english('tool.check_doc_sync.ok')).toBe('Documentation and code are in sync.')
    expect(chinese('command.toggle.check.clean')).toBe('没有发现阻塞性问题。')
  })

  it('interpolates the parameters a template names', () => {
    const english = createTranslator('en-US')
    expect(english('command.toggle.unknown', { input: 'wat' })).toContain('wat')
    expect(english('tool.check_commit_message.warn.missing_scope', { module: 'src' })).toContain(
      'src',
    )
  })

  it('leaves a placeholder intact when its parameter is missing', () => {
    const english = createTranslator('en-US')
    expect(english('command.toggle.unknown')).toBe(
      'Unknown subcommand "{input}". Use on, off, status, or check.',
    )
  })

  it('falls back to the key itself for a key that does not exist', () => {
    const english = createTranslator('en-US')
    expect(english('no.such.key')).toBe('no.such.key')
    expect(createTranslator('zh-CN')('no.such.key')).toBe('no.such.key')
    // A key that is present in one dictionary only would print itself rather
    // than `undefined`, which is what keeps a missing translation visible.
    expect(english('meta.title')).toBe('meta.title')
  })

  it('resolves an explicit locale without consulting the environment', () => {
    expect(resolveLocale('en-US')).toBe('en-US')
    expect(resolveLocale('zh-CN')).toBe('zh-CN')
  })

  it('resolves auto to a shipped locale', () => {
    expect(['en-US', 'zh-CN']).toContain(resolveLocale('auto'))
  })
})
