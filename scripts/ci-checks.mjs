// CI guardrails that need no third-party dependency.
//
// 1. The shipped locale dictionaries must expose exactly the same key set.
//    CI checks that the keys line up; whether a translation is *correct* is a
//    human review item and cannot be automated here.
// 2. The bundle manifest must ship cordis.patch.yml, or the patch never applies.
//    `dsh.bundle.patch` is read from package.json and resolved relative to the
//    package directory, so both the pointer and the file have to line up.
// 3. SKILL.md and SKILL.zh.md must stay the same specification in two languages:
//    each carries valid frontmatter, and both expose the same sections in the
//    same order.
//
//    The headings themselves are localized (matching README.md / README.zh.md),
//    so cross-language order cannot be compared as text. What is checked is the
//    heading *shape*: the same count of `##` sections, and the same sequence of
//    heading levels, at every position. A section added to one file only, or a
//    subsection introduced in one file only, fails.
// 4. No shipped document may cite a development phase by number. The numbered
//    phases are defined in `.dev-docs/PROGRESS.md`, which is gitignored and
//    absent from a clone, so a reader on GitHub cannot resolve "已接受（第七阶段）".
//    The two files that legitimately keep the numbering are exempt: CONTRIBUTING
//    defines it, and CHANGELOG is a historical record.
// 5. The published package must contain the files the host loads. `lib/` is a
//    build output, absent from a fresh clone, so `prepack` builds first and then
//    runs this script to prove the entry points exist and that `files` ships
//    them. See the comment at the check itself for why it does not shell out.
// 6. A pull request that changes one half of a mirrored pair must change the
//    other half. The session tool `check_doc_sync` enforces this while the
//    plugin is loaded, which does nothing for a contributor who does not use
//    DSH — and the pair rule is the same rule either way, so it is read from
//    the same place rather than restated here.
// 7. The version in package.json, the CHANGELOG entry for it, and the git tags
//    are one fact written down three times. A release that updates two of them
//    ships a package whose changelog has no entry for it.
// 8. A change past 500 lines gets a warning, not a failure. Merging is squash,
//    so whatever a pull request contains lands as one commit with one message:
//    a branch holding four unrelated concerns loses that structure the moment it
//    merges, and the message describes the first concern only. The number is a
//    warning because at that size splitting is expensive and a hard gate only
//    teaches people to re-cut the branch instead of the change.
// 9. The DSH requirement has two homes, `engines.dsh` and the `@deepseek-ai/dsh`
//    peer range, and they must say the same thing. DSH reads `engines.dsh` first
//    and skips the peer check once it is present, so a package whose two copies
//    disagree enforces whichever one it happened to write first — and a
//    marketplace that reads only `engines.dsh` reports "author declares no DSH
//    requirement" for a package that does declare one.
// 10. An entry in `[Unreleased]` stays under 120 characters. The release page is
//    copied from these entries verbatim, so this is the release page's length —
//    and the skill's guidance ("one or two sentences") did not hold in practice,
//    because an entry that narrates the before-state and the mechanism reads as
//    thoroughness while writing it. Only `[Unreleased]` is checked; released
//    sections are history and rewriting them changes no past page.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, root), 'utf8'))

/**
 * The paths this change touches, as repository-relative paths.
 *
 * A pull request is compared against its base; a local run against the base
 * branch it was cut from. A clone with no such ref (a shallow or detached
 * checkout, or a repository with one branch) has nothing to compare, and
 * reporting an empty change is the honest answer — this check cannot see a
 * difference it was given no base for.
 * @returns the changed paths, or an empty list when no base ref resolves.
 */
function changedFiles() {
  const bases = ['origin/main', 'main']
  for (const base of bases) {
    try {
      const output = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
        cwd: new URL('.', root),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return output.split('\n').filter((line) => line.length > 0)
    } catch {
      // No such ref, or no git at all: try the next base.
    }
  }
  return []
}

/**
 * Lines added plus lines removed against the base branch, or undefined when no
 * base resolves (same reason `changedFiles` reports nothing: there is nothing
 * to compare against).
 * @returns the changed line count, or undefined without a base ref.
 */
function diffSize() {
  for (const base of ['origin/main', 'main']) {
    try {
      const output = execFileSync('git', ['diff', '--numstat', `${base}...HEAD`], {
        cwd: new URL('.', root),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      // Binary files report `-` for both columns and contribute no lines.
      return output
        .split('\n')
        .filter((line) => line.length > 0)
        .reduce((total, line) => {
          const [added, removed] = line.split('\t')
          return total + (Number(added) || 0) + (Number(removed) || 0)
        }, 0)
    } catch {
      // No such ref, or no git at all: try the next base.
    }
  }
  return undefined
}

/** Flatten to dot paths so a nested dict cannot hide a missing key. */
function keyPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? keyPaths(child, path)
      : [path]
  })
}

const failures = []
const warnings = []
/** Rule 8's threshold: the skill's own guidance, past which a change is split. */
const CHANGE_SIZE_LIMIT = 500

// A passing check says so. Printing only the failures makes a green run look
// identical to a run where half the checks never executed, which is the failure
// mode this whole file exists to prevent. `mark()` records the failure count
// before a check; `ok()` prints the check's name only if nothing was added.
const mark = () => failures.length
const ok = (name, before) => {
  if (failures.length === before) console.log(`[ok] ${name}`)
}

const locales = ['locale/en.json', 'locale/zh.json']
let before = mark()
const keySets = locales.map((file) => new Set(keyPaths(readJson(file))))
const [en, zh] = keySets
for (const key of en) if (!zh.has(key)) failures.push(`${locales[1]} is missing key "${key}"`)
for (const key of zh) if (!en.has(key)) failures.push(`${locales[0]} is missing key "${key}"`)
ok(`locale keys aligned (${en.size} keys)`, before)

const skillFiles = ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md']
before = mark()

/**
 * Read a skill file: validate its frontmatter and return the heading levels of
 * its body, so the two languages can be compared structurally.
 */
function readSkill(relative) {
  const text = readFileSync(new URL(relative, root), 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    failures.push(`${relative}: missing YAML frontmatter`)
    return []
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) {
    failures.push(`${relative}: unterminated YAML frontmatter`)
    return []
  }

  const frontmatter = lines.slice(1, close).join('\n')
  const name = /^name:\s*(\S.*)$/m.exec(frontmatter)
  if (name === null) failures.push(`${relative}: frontmatter requires name`)
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name[1].trim())) {
    failures.push(`${relative}: skill name "${name[1].trim()}" is not kebab-case`)
  }
  // `description: >` is a block scalar: the value lives on the following lines.
  if (!/^description:\s*(?:[>|].*)?$/m.test(frontmatter)) {
    failures.push(`${relative}: frontmatter requires description`)
  }

  // Heading shape only: `##`-level sections, in order. The heading text differs
  // per language by design, so only the level sequence is comparable.
  // Fenced code blocks are skipped: the PR template inside one contains `##`
  // lines that are sample text, not sections of this specification.
  const shape = []
  let fence = null
  for (const line of lines.slice(close + 1)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1][0]
      fence = fence === null ? marker : fence === marker ? null : fence
      continue
    }
    if (fence !== null) continue
    const heading = /^(#{1,6})\s+\S/.exec(line)
    if (heading !== null) shape.push(heading[1])
  }
  return shape
}

const skillShapes = skillFiles.map(readSkill)
const [enShape, zhShape] = skillShapes
if (enShape.length !== zhShape.length) {
  failures.push(
    `${skillFiles[1]}: has ${zhShape.length} headings, ${skillFiles[0]} has ${enShape.length}`,
  )
} else {
  for (let i = 0; i < enShape.length; i += 1) {
    if (enShape[i] !== zhShape[i]) {
      failures.push(
        `${skillFiles[1]}: heading ${i + 1} is "${zhShape[i]}" but ${skillFiles[0]} uses "${enShape[i]}"`,
      )
    }
  }
}
ok(`skill headings aligned (${enShape.length} sections)`, before)

// 4. Phase-number citations, as described above. Walking the repository also
//    covers `.dev-docs/`, where the numbering is actually defined, so that
//    directory is skipped explicitly.
const PHASE = /第\s*[0-9一二三四五六七八九十]+\s*阶段|\bPhase\s+[0-9]+\b/
// CONTRIBUTING.md defines the numbered phases; CHANGELOG.md is a historical
// record of when they happened. Both are the only legitimate citations.
const phaseExempt = new Set(['CONTRIBUTING.md', 'CHANGELOG.md'])
/** Every tracked `.md` file, as repository-relative paths. */
function trackedMarkdown(directory = '') {
  const found = []
  const skipped = new Set(['node_modules', '.dev-docs', '.git'])
  for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
    const relative = `${directory}${entry.name}`
    if (entry.isDirectory()) {
      if (skipped.has(entry.name)) continue
      found.push(...trackedMarkdown(`${relative}/`))
    } else if (entry.name.endsWith('.md') && !phaseExempt.has(relative)) {
      found.push(relative)
    }
  }
  return found
}
before = mark()
for (const file of trackedMarkdown()) {
  const lines = readFileSync(new URL(file, root), 'utf8').split(/\r?\n/)
  const line = lines.findIndex((entry) => PHASE.test(entry))
  if (line !== -1) {
    failures.push(
      `${file}:${line + 1} cites a development phase by number; the phases are defined ` +
        `only in .dev-docs/PROGRESS.md, which is not published (use a date instead)`,
    )
  }
}
ok('no numbered development phases cited', before)

const pkg = readJson('package.json')
before = mark()
const patch = pkg.dsh?.bundle?.patch
if (typeof patch !== 'string') {
  failures.push('package.json: dsh.bundle.patch is not declared')
} else {
  if (!existsSync(new URL(patch, root))) failures.push(`package.json: ${patch} does not exist`)
  if (!pkg.files?.includes(patch.replace(/^\.\//, ''))) {
    failures.push(
      `package.json: files does not include ${patch} (the patch would not be published)`,
    )
  }
}
ok('bundle patch declared and shipped', before)

// 5. The tarball must contain the files the host actually loads. `lib/` is a
//    build output: it is gitignored and absent from a fresh clone, so packing
//    without building first produces an installable package whose entry point
//    does not exist. `prepack` runs the build and this check in that order.
//    The check is done against the filesystem and the `files` whitelist rather
//    than by shelling out to `npm pack --dry-run --json`: prepack calls this
//    script, so packing from inside it would recurse. Existence plus whitelist
//    coverage is what the tarball listing would prove.
/** Entries in `files`: a trailing slash is a directory prefix, otherwise exact. */
before = mark()
const shipped = [
  'lib/index.js',
  'lib/index.d.ts',
  'client.js',
  'locale/en.json',
  'locale/zh.json',
  'skills/dsh-dev-workflow/SKILL.md',
  'skills/dsh-dev-workflow/SKILL.zh.md',
  'cordis.patch.yml',
]
const covered = (file) =>
  (pkg.files ?? []).some((entry) =>
    entry.endsWith('/') ? file.startsWith(entry) : entry.replace(/^\.\//, '') === file,
  )
for (const file of shipped) {
  if (!existsSync(new URL(file, root))) {
    failures.push(`${file} is missing (run \`pnpm build\` before packing)`)
  } else if (!covered(file)) {
    failures.push(`package.json: files does not include ${file}`)
  }
}

//    The emitted maps name `../src/*.ts`. Shipping them without `src/` leaves a
//    consumer's debugger pointing at a path the tarball never had, which is worse
//    than no map at all: it looks like a working one until the first breakpoint.
const emittedMaps = ['lib/index.js.map', 'lib/index.d.ts.map']
if (emittedMaps.some((file) => existsSync(new URL(file, root))) && !covered('src/index.ts')) {
  failures.push('package.json: files excludes src/ while the build emits source maps')
}
ok(`published entry points present (${shipped.length} checked)`, before)

// 6. Mirrored pairs. The pair rule is the plugin's own (`docs.mirrors` in
//    `src/config.ts`), so the list below is the schema's default, kept here only
//    because a fresh clone has no build output to import it from.
const mirrors = pkg.dsh?.config?.docs?.mirrors ?? [
  ['README.md', 'README.zh.md'],
  ['locale/en.json', 'locale/zh.json'],
  ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md'],
]
const changed = new Set(changedFiles())
before = mark()
for (const pair of mirrors) {
  const touched = pair.filter((file) => changed.has(file))
  if (touched.length > 0 && touched.length < pair.length) {
    failures.push(
      `${touched[0]}: changed without its mirror (${pair.filter((f) => !changed.has(f)).join(', ')})`,
    )
  }
}
ok(`mirrored pairs consistent (${mirrors.length} groups)`, before)

// 7. Version alignment. The titled heading is what the release notes point at,
//    so a version without one is a release nobody can read about.
before = mark()
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
const escaped = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
if (!new RegExp(`^##\\s+\\[?v?${escaped}\\]?\\b`, 'm').test(changelog)) {
  failures.push(`CHANGELOG.md: no section for the released version ${pkg.version}`)
}
ok(`CHANGELOG records ${pkg.version}`, before)

// 8. Change size, as described above. Skipped silently when no base resolves,
//    which is the same blind spot rules 6 and 7 have.
const size = diffSize()
if (size !== undefined && size > CHANGE_SIZE_LIMIT) {
  warnings.push(
    `${size} changed lines against the base branch (over ${CHANGE_SIZE_LIMIT}). ` +
      `A squash merge lands this as one commit; split it, or say in the description ` +
      `which concern is which`,
  )
} else if (size !== undefined) {
  console.log(`[ok] ${size} changed lines, under the ${CHANGE_SIZE_LIMIT}-line guidance`)
}

// 9. The DSH requirement is written down twice: `engines.dsh` and the
//    `@deepseek-ai/dsh` peer range. DSH reads `engines.dsh` first and skips the
//    peer check entirely once it is present (`unmetRequirements()` in
//    `dsh-app-boot`), so the two copies are one fact with two homes — and a
//    marketplace that reads only `engines.dsh` reports "author declares no DSH
//    requirement" for a package that does declare one. Comparing them here is
//    cheaper than remembering to edit both.
before = mark()
const enginesDsh = pkg.engines?.dsh
const peerDsh = pkg.peerDependencies?.['@deepseek-ai/dsh']
if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') {
  failures.push('package.json: engines.dsh is not declared (DSH falls back to the peer ranges)')
} else if (enginesDsh !== peerDsh) {
  failures.push(
    `package.json: engines.dsh (${enginesDsh}) and the @deepseek-ai/dsh peer (${peerDsh}) disagree`,
  )
}
ok('DSH requirement declared consistently', before)

// 10. Every entry in `[Unreleased]` stays under the ceiling the skill states.
//     The release page is copied from these entries verbatim, so an entry that
//     explains *how* a fix works — the before-state, the mechanism, the after —
//     reads as diligence here and makes the release page unreadable there. The
//     rule text alone did not hold; a measurable ceiling does. Released sections
//     are history and are not checked.
before = mark()
const ENTRY_LIMIT = 120
const unreleased = changelog.split(/^## \[Unreleased\][^\n]*$/m)[1]?.split(/^## \[/m)[0] ?? ''
for (const raw of unreleased.split(/^- /m).slice(1)) {
  const entry = raw
    .split(/\n(?=- |### )/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  const length = [...entry].length
  if (length > ENTRY_LIMIT) {
    failures.push(
      `CHANGELOG.md: [Unreleased] entry is ${length} characters (over ${ENTRY_LIMIT}): ` +
        `${entry.slice(0, 24)}…`,
    )
  }
}
ok('CHANGELOG entries stay within the length ceiling', before)

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  process.exit(1)
}
for (const warning of warnings) console.warn(`warning: ${warning}`)
