import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// SKILL.md and SKILL.zh.md are one specification in two languages. The headings
// are translated, so they cannot be compared as text; what has to match is the
// structure — same sections, same nesting, same order. `scripts/ci-checks.mjs`
// guards the same invariant for CI; this spec is the copy a contributor runs
// locally, and it pins the exact counts so a silent drift fails loudly.

const FILES = {
  en: 'skills/dsh-dev-workflow/SKILL.md',
  zh: 'skills/dsh-dev-workflow/SKILL.zh.md',
} as const

/**
 * The headings of a skill file, in order, with fenced code blocks skipped.
 *
 * A fenced block in SKILL.md carries a sample pull-request template whose `##`
 * lines are sample text rather than sections of the specification, so counting
 * them would make the two files look different for the wrong reason.
 * @param text - the file contents.
 * @returns one `"<level> <title>"` entry per heading.
 */
function headings(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  const body = close === -1 ? lines : lines.slice(close + 1)
  const found: string[] = []
  let fence: string | null = null

  for (const line of body) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker !== null) {
      const char = marker[1]?.[0] ?? '`'
      fence = fence === null ? char : fence === char ? null : fence
      continue
    }
    if (fence !== null) continue
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading !== null) found.push(`${heading[1]} ${heading[2]}`)
  }

  return found
}

/** The heading level of an entry, e.g. `##`. */
const levelOf = (heading: string): string => heading.slice(0, heading.indexOf(' '))

/** How many headings of each level an entry list contains. */
function levelCounts(headings: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const heading of headings) {
    const level = levelOf(heading)
    counts[level] = (counts[level] ?? 0) + 1
  }
  return counts
}

const english = headings(readFileSync(FILES.en, 'utf8'))
const chinese = headings(readFileSync(FILES.zh, 'utf8'))

describe('skills/dsh-dev-workflow', () => {
  it('exposes the same number of headings in both languages', () => {
    expect(english).toHaveLength(28)
    expect(chinese).toHaveLength(28)
    expect(chinese.length).toBe(english.length)
  })

  it('exposes the same number of headings at each level', () => {
    const expected = { '#': 1, '##': 10, '###': 17 }
    expect(levelCounts(english)).toEqual(expected)
    expect(levelCounts(chinese)).toEqual(expected)
  })

  it('exposes the same heading sequence in the same order', () => {
    // The titles are localized, so the comparable shape is the level at each
    // position: a section added to one file only shifts every later position and
    // fails here, naming the heading that came from where.
    const englishLevels = english.map(levelOf)
    const chineseLevels = chinese.map(levelOf)

    for (const [index, level] of englishLevels.entries()) {
      expect(chineseLevels[index], `heading ${index + 1}`).toBe(level)
    }
    expect(chineseLevels).toEqual(englishLevels)
  })

  it('opens each file with a single level-one title', () => {
    expect(levelOf(english[0] ?? '')).toBe('#')
    expect(levelOf(chinese[0] ?? '')).toBe('#')
    expect(english.filter((heading) => levelOf(heading) === '#')).toHaveLength(1)
    expect(chinese.filter((heading) => levelOf(heading) === '#')).toHaveLength(1)
  })

  it('declares valid frontmatter in both languages', () => {
    for (const file of Object.values(FILES)) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split(/\r?\n/)
      expect(lines[0]?.trim(), file).toBe('---')
      const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
      expect(close, file).toBeGreaterThan(0)

      const frontmatter = lines.slice(1, close).join('\n')
      expect(/^name:\s*(\S.*)$/m.exec(frontmatter)?.[1]?.trim(), file).toBe('dsh-dev-workflow')
      expect(/^description:/m.test(frontmatter), file).toBe(true)
    }
  })
})
