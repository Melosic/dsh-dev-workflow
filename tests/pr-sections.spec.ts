import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PR_TEMPLATE_PATHS,
  isDefaultSections,
  readTemplateSections,
  resolveSections,
  roleOf,
  sectionsFromNames,
  sectionsFromTemplate,
} from '../src/pr-sections.js'
import { PR_SECTIONS } from '../src/config.js'

// Which sections a description is judged against is a property of the
// repository's own template. Getting this wrong is not a wrong verdict on one
// pull request — it is every pull request in that repository being told it
// missed a heading its template never asked for.

const made: string[] = []

afterEach(async () => {
  while (made.length > 0) await rm(made.pop()!, { recursive: true, force: true })
})

/**
 * Create a scratch repository holding one pull request template.
 * @param relativePath - where to write the template, relative to the root.
 * @param text - the template's contents.
 * @returns the scratch repository's path.
 */
async function repoWith(relativePath: string, text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pr-sections-'))
  made.push(root)
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return root
}

describe('roleOf', () => {
  it('recognises the spellings templates actually use', () => {
    expect(roleOf('What')).toBe('what')
    expect(roleOf('Summary')).toBe('what')
    expect(roleOf('How to verify')).toBe('verify')
    expect(roleOf('How to test')).toBe('verify')
    expect(roleOf('Type of change')).toBe('type')
    expect(roleOf('Non-goals')).toBe('nongoals')
    expect(roleOf('Risk and rollback')).toBe('risk')
    expect(roleOf('Checklist')).toBe('checklist')
  })

  it('ignores case, punctuation, and emphasis', () => {
    expect(roleOf('NON-GOALS')).toBe('nongoals')
    expect(roleOf('**Checklist**')).toBe('checklist')
    expect(roleOf('Non goals')).toBe('nongoals')
  })

  it('recognises the Chinese spellings of the same questions', () => {
    expect(roleOf('改了什么')).toBe('what')
    expect(roleOf('为什么')).toBe('why')
    expect(roleOf('怎么验证')).toBe('verify')
    expect(roleOf('检查清单')).toBe('checklist')
  })

  it('leaves a heading it does not know alone', () => {
    // A template's own prose section is not a question this check has a rule
    // for; demanding it would be inventing a requirement.
    expect(roleOf('Where to look first')).toBeUndefined()
    expect(roleOf('Screenshots')).toBeUndefined()
  })
})

describe('sectionsFromTemplate', () => {
  it('reads the headings a template states, in order', () => {
    const template = ['## What', 'x', '## How to verify', 'y', '## Checklist', 'z'].join('\n')
    expect(sectionsFromTemplate(template)).toEqual([
      { heading: 'What', role: 'what' },
      { heading: 'How to verify', role: 'verify' },
      { heading: 'Checklist', role: 'checklist' },
    ])
  })

  it('drops headings it has no rule for and keeps the rest', () => {
    const template = ['## What', 'x', '## Screenshots', 'y', '## Why', 'z'].join('\n')
    expect(sectionsFromTemplate(template).map((section) => section.heading)).toEqual([
      'What',
      'Why',
    ])
  })

  it('does not read a heading out of a comment or a code fence', () => {
    // Templates describe themselves: the hint "write `## What` here" sits inside
    // a comment, and half of them show a markdown example in a fence.
    const template = [
      '<!-- put ## Summary here -->',
      '```md',
      '## Why',
      '```',
      '## What',
      'x',
    ].join('\n')
    expect(sectionsFromTemplate(template).map((section) => section.heading)).toEqual(['What'])
  })

  it('reads a heading once even when the template repeats it', () => {
    const template = ['## What', 'x', '## What', 'y'].join('\n')
    expect(sectionsFromTemplate(template)).toHaveLength(1)
  })
})

describe('sectionsFromNames', () => {
  it('enforces a configured name whether or not its role is known', () => {
    // A name in `prSections` is the author saying this repository asks for it.
    // Filtering it through the spelling list would silently drop what they added
    // to be checked.
    expect(sectionsFromNames(['背景', '改动', '验证'])).toEqual([
      { heading: '背景', role: 'why' },
      { heading: '改动', role: 'what' },
      { heading: '验证', role: 'verify' },
    ])
    expect(sectionsFromNames(['Screenshots'])).toEqual([{ heading: 'Screenshots' }])
  })

  it('drops blanks and repeats', () => {
    expect(sectionsFromNames(['What', ' ', 'what'])).toEqual([{ heading: 'What', role: 'what' }])
  })
})

describe('isDefaultSections', () => {
  it('recognises the built-in list, and only that list', () => {
    expect(isDefaultSections([...PR_SECTIONS])).toBe(true)
    expect(isDefaultSections(PR_SECTIONS.slice(0, 1))).toBe(false)
    expect(isDefaultSections([...PR_SECTIONS].reverse())).toBe(false)
  })
})

describe('readTemplateSections', () => {
  it('finds the template at any of the paths GitHub reads', async () => {
    const root = await repoWith('.github/PULL_REQUEST_TEMPLATE.md', '## What\nx\n## Why\ny')
    expect((await readTemplateSections(root))?.map((section) => section.heading)).toEqual([
      'What',
      'Why',
    ])
    expect(PR_TEMPLATE_PATHS.length).toBeGreaterThan(1)
  })

  it('reports no template at all as undefined', async () => {
    const root = await repoWith('README.md', '# not a template')
    expect(await readTemplateSections(root)).toBeUndefined()
  })

  it('reports a template with no recognised heading as an empty list', async () => {
    // Not `undefined`: the repository does have a template, and what it says is
    // that the description is free-form.
    const root = await repoWith('.github/pull_request_template.md', '## Screenshots\nx')
    expect(await readTemplateSections(root)).toEqual([])
  })
})

describe('resolveSections', () => {
  it('reads the template while the setting is untouched', async () => {
    const root = await repoWith('.github/pull_request_template.md', '## What\nx\n## 怎么验证\ny')
    const sections = await resolveSections(root, [...PR_SECTIONS])
    expect(sections.map((section) => section.heading)).toEqual(['What', '怎么验证'])
    expect(sections.map((section) => section.role)).toEqual(['what', 'verify'])
  })

  it('lets a changed setting win over the template', async () => {
    // The repository spelled its headings out in the configuration, which is a
    // more specific statement than the template file.
    const root = await repoWith('.github/pull_request_template.md', '## What\nx')
    const sections = await resolveSections(root, ['背景', '改动'])
    expect(sections.map((section) => section.heading)).toEqual(['背景', '改动'])
  })

  it('falls back to the defaults when the repository has no template', async () => {
    const root = await repoWith('README.md', '# nothing here')
    expect(
      (await resolveSections(root, [...PR_SECTIONS])).map((section) => section.heading),
    ).toEqual([...PR_SECTIONS])
  })
})
