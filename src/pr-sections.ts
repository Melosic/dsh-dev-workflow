import { join } from 'node:path'
import { PR_SECTIONS } from './config.js'
import { readText } from './triggers/shared.js'

// Which `##` sections a pull request description is judged against.
//
// The section names are a property of the repository's template, not of this
// workflow: a repository that fills in `.github/pull_request_template.md` has
// already said which headings it wants, and a hardcoded list would tell every
// one of its pull requests it is missing sections its template never asked for.
// So the template is read first, the `prSections` setting is the override for
// repositories whose template this cannot recognise, and the built-in defaults
// are the last resort.
//
// Reading a heading is the only part that needs judgement, and it is deliberately
// generous: the same question is written `## What`, `## Summary`, `## 改了什么`. A
// heading whose role cannot be recognised is left alone — it is prose the author
// may delete, and judging it missing would be a rule the template never wrote.

/** What one template heading asks the author to answer. */
export type SectionRole = 'what' | 'why' | 'verify' | 'type' | 'nongoals' | 'risk' | 'checklist'

/** One section of a description, and what it is for when that is known. */
export interface ResolvedSection {
  /** The heading as the template (or the setting) spells it. */
  readonly heading: string
  /** What the heading asks for, when it is recognised. */
  readonly role?: SectionRole
}

/**
 * The spellings each role is known by, with everything but letters and CJK
 * characters removed — the same normalisation {@link roleOf} applies to a
 * heading, so `Non-goals`, `non goals` and `NON-GOALS` all land on `nongoals`
 * and every spelling here is written without punctuation or spaces.
 */
const ROLE_SPELLINGS: Readonly<Record<SectionRole, readonly string[]>> = {
  what: [
    'what',
    'summary',
    'description',
    'overview',
    'whatchanged',
    'whatitdoes',
    '改了什么',
    '做了什么',
    '改动',
    '变更内容',
    '概述',
    '说明',
  ],
  why: [
    'why',
    'motivation',
    'background',
    'rationale',
    'whythis',
    '为什么',
    '动机',
    '背景',
    '原因',
  ],
  verify: [
    'howtoverify',
    'howtotest',
    'howitested',
    'testing',
    'testplan',
    'verification',
    'evidence',
    '怎么验证',
    '如何验证',
    '验证方式',
    '验证',
    '测试',
  ],
  type: ['typeofchange', 'changetype', 'kindofchange', 'type', '变更类型', '改动类型', '类型'],
  nongoals: ['nongoals', 'nongoal', 'outofscope', '非目标', '不做什么', '范围外', '不在范围内'],
  risk: [
    'riskandrollback',
    'risksandrollback',
    'risks',
    'risk',
    'rollback',
    '风险和回滚',
    '风险与回滚',
    '风险',
    '回滚',
  ],
  checklist: ['checklist', 'checklistitems', '检查清单', '自查清单', '清单'],
}

/** Spelling to role, built once from {@link ROLE_SPELLINGS}. */
const ROLE_BY_SPELLING = new Map<string, SectionRole>(
  Object.entries(ROLE_SPELLINGS).flatMap(([role, spellings]) =>
    spellings.map((spelling) => [spelling, role as SectionRole] as const),
  ),
)

/**
 * Where a repository keeps its pull request template.
 *
 * GitHub reads all of these; the order is the one that puts the documented
 * default first, because a repository that has both meant the `.md` one.
 */
export const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
] as const

/**
 * Reduce a heading to the letters and CJK characters that identify it.
 * @param heading - the heading text, without the leading `##`.
 * @returns the normalised form used for lookup.
 */
function normalise(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

/**
 * What a heading asks for, when it is recognised.
 * @param heading - the heading text, without the leading `##`.
 * @returns the role, or `undefined` for a heading this check does not know.
 */
export function roleOf(heading: string): SectionRole | undefined {
  return ROLE_BY_SPELLING.get(normalise(heading))
}

/**
 * Turn a list of configured names into sections.
 *
 * A name the author put in `prSections` is enforced whether or not its role is
 * recognised: they said this repository asks for it, and second-guessing that
 * with a spelling list would silently drop the sections they added to be
 * checked.
 * @param names - the configured section names.
 * @returns one section per distinct name, in the order given.
 */
export function sectionsFromNames(names: readonly string[]): ResolvedSection[] {
  const sections: ResolvedSection[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const key = name.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    const role = roleOf(name)
    sections.push(role === undefined ? { heading: name } : { heading: name, role })
  }
  return sections
}

/**
 * Read the `##` sections a template states.
 *
 * Only headings with a recognised role are returned. Everything else is a
 * section this check has no rule for, and demanding it would invent a
 * requirement — but note that a template with no recognised heading at all
 * returns an empty list, which the caller reads as "this repository does not want
 * its description sectioned".
 * @param text - the template's markdown.
 * @returns the recognised sections, in template order.
 */
export function sectionsFromTemplate(text: string): ResolvedSection[] {
  // A heading inside a comment or a code fence is an example of a heading, not a
  // section; the template files this is pointed at are mostly comments.
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '')
  const sections: ResolvedSection[] = []
  const seen = new Set<string>()
  let fenced = false
  for (const line of withoutComments.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading === null) continue
    const name = (heading[1] ?? '').trim()
    const key = name.toLowerCase()
    if (name.length === 0 || seen.has(key)) continue
    const role = roleOf(name)
    if (role === undefined) continue
    seen.add(key)
    sections.push({ heading: name, role })
  }
  return sections
}

/**
 * Whether a configuration still holds the built-in list.
 * @param names - the configured section names.
 * @returns whether they are the defaults, which is when the template wins.
 */
export function isDefaultSections(names: readonly string[]): boolean {
  return (
    names.length === PR_SECTIONS.length && names.every((name, index) => name === PR_SECTIONS[index])
  )
}

/**
 * Decide which sections one pull request description is judged against.
 *
 * The setting wins whenever it has been changed: a repository that spelled its
 * headings out in `prSections` has said what it wants, and a template this
 * check reads differently must not overrule it. At the default value the template
 * has the first word — that is the whole point of reading it — and the defaults
 * remain the fallback for a repository with no template at all.
 * @param cwd - the repository root.
 * @param configured - the `prSections` setting.
 * @returns the sections to enforce, in the order the report lists them.
 */
export async function resolveSections(
  cwd: string,
  configured: readonly string[],
): Promise<readonly ResolvedSection[]> {
  if (!isDefaultSections(configured)) return sectionsFromNames(configured)
  const template = await readTemplateSections(cwd)
  return template ?? sectionsFromNames(configured)
}

/**
 * Read the sections this repository's pull request template states.
 * @param cwd - the repository root.
 * @returns the template's sections, an empty list when it states none this check
 * recognises, or `undefined` when the repository has no template to read.
 */
export async function readTemplateSections(
  cwd: string,
): Promise<readonly ResolvedSection[] | undefined> {
  for (const path of PR_TEMPLATE_PATHS) {
    const text = await readText(join(cwd, path))
    if (text !== undefined) return sectionsFromTemplate(text)
  }
  return undefined
}
