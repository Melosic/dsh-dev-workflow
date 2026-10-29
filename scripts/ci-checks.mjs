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
//    CHANGELOG.md is the one exemption left: it is a historical record, and the
//    entries that named a phase were written when that file was where the plan
//    lived. New prose must not reintroduce the numbering.
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
//    ships a package whose changelog has no entry for it. Both directions that
//    can be checked before a release are: every tag has a section, and
//    package.json's version has one. The third direction — the version has a tag
//    — is not checked, because the tag is cut after the section is merged, so
//    "no tag yet" is the normal state of every open release pull request.
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
//
//    The range must also be closed above. An open `>=0.2.0-rc.2` admits every
//    future 0.x release, so a plugin that loaded on 0.2 loads on 0.3 too, and the
//    first sign of an incompatible API change is a runtime error in a user's
//    session instead of the host disabling the plugin at startup with a reason.
//    A closed range is what makes "supported" mean something: below the floor and
//    above the ceiling are both "not tested", and one of them used to pass.
// 10. An entry in `[Unreleased]` stays under 120 characters. The release page is
//    copied from these entries verbatim, so this is the release page's length —
//    and the skill's guidance ("one or two sentences") did not hold in practice,
//    because an entry that narrates the before-state and the mechanism reads as
//    thoroughness while writing it. Only `[Unreleased]` is checked; released
//    sections are history and rewriting them changes no past page.
// 11. A pull request whose squashed commit message claims a user-visible change
//    (`feat:` / `fix:`) must touch CHANGELOG.md, because the entry is what the
//    release page is copied from and there is no later moment where someone
//    remembers. A change under `src/` that claims neither is a warning instead of
//    a failure: an internal refactor belongs in the diff, not in the changelog,
//    and a hard gate there only teaches people to write a filler entry. The title
//    comes from `PR_TITLE`, which CI sets; a local run has no title and is judged
//    on the paths alone.
// 12. Every released heading has a link definition at the bottom, and the link
//    points at the compare range that produced it. The bottom of CHANGELOG.md is
//    the only place the release pages' `Full Changelog:` line comes from, and a
//    copy-pasted entry keeps the previous version's edges — which renders as a
//    valid link to the wrong diff, the one failure mode that looks correct.
// 13. Rule 1 proves the two dictionaries have the same keys; it says nothing
//    about which language they are in. A CJK character in `locale/en.json` — or
//    in the English half of `client.js` — means someone edited the wrong file,
//    and an English reader is then shown Chinese. So does a CJK string in
//    `src/` outside a comment: user-visible text goes through `t()` and lives
//    in the dictionaries, never inline. Comments are exempt because several
//    quote a Chinese heading as an example of what a configuration value may
//    contain, and `src/triggers/pre-pr.ts` is exempt because it matches what a
//    user typed ("无", "不适用") and never prints it. Rewriting an English
//    comment is a review item, not something a character class can judge.
// 14. The release page's two halves and its closing link are copied from the
//    template in docs/PUBLISHING.md, which is the only part of a release page a
//    checkout can see - the page itself lives on GitHub. So the template is
//    checked instead: one `<h3 id>` anchor per language naming the same version,
//    and a closing `Full Changelog:` line whose compare range starts at the
//    previous released version and ends at that same version. A template that
//    keeps a stale range is how a release page ends up linking to the wrong
//    diff, which renders as a valid link and gets read as correct.

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
      return [
        ...new Set([...output.split('\n').filter((line) => line.length > 0), ...dirtyFiles()]),
      ]
    } catch {
      // No such ref, or no git at all: try the next base.
    }
  }
  return []
}

/**
 * Paths with uncommitted changes, so a local run sees the work in progress.
 *
 * `changedFiles` compares commits, and a contributor running `pnpm ci:checks`
 * before committing has none of their work in a commit yet — every rule keyed on
 * the changed paths then reports the same thing it reports on a clean tree. CI
 * checks out a real commit and adds nothing here.
 * @returns the uncommitted paths, or an empty list outside a git repository.
 */
function dirtyFiles() {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: new URL('.', root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return output
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3).split(' -> ').pop())
      .filter((path) => path !== undefined)
  } catch {
    return []
  }
}

/**
 * Total lines in one `git diff --numstat` listing. Binary files report `-` for
 * both columns and contribute no lines.
 * @param args - the diff arguments, never including a path filter.
 * @returns the added plus removed line count, or undefined when git refuses.
 */
function numstatTotal(args) {
  try {
    const output = execFileSync('git', ['diff', ...args], {
      cwd: new URL('.', root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output
      .split('\n')
      .filter((line) => line.length > 0)
      .reduce((total, line) => {
        const [added, removed] = line.split('\t')
        return total + (Number(added) || 0) + (Number(removed) || 0)
      }, 0)
  } catch {
    return undefined
  }
}

/**
 * Lines in the files git does not track yet, so a new file counts as a change
 * rather than as no change at all.
 * @returns the line count of every untracked, non-ignored file.
 */
function untrackedLines() {
  try {
    const list = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: new URL('.', root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return list
      .split('\n')
      .filter((path) => path.length > 0)
      .reduce(
        (total, path) => total + readFileSync(new URL(path, root), 'utf8').split('\n').length - 1,
        0,
      )
  } catch {
    return 0
  }
}

/**
 * Lines added plus lines removed, counted the way `changedFiles` sees the tree:
 * the commits on this branch against the base, plus the work not committed yet.
 * A local run before the first commit otherwise reports nothing to measure and
 * prints "0 changed lines" for a tree that is visibly large.
 * @returns the changed line count, or undefined when no base ref resolves.
 */
function diffSize() {
  for (const base of ['origin/main', 'main']) {
    const committed = numstatTotal(['--numstat', `${base}...HEAD`])
    if (committed === undefined) continue
    const working = numstatTotal(['--numstat', 'HEAD']) ?? 0
    return committed + working + untrackedLines()
  }
  return undefined
}

/**
 * The release tags this checkout knows about, newest first.
 *
 * A repository with no tags, or no git at all, reports none — the tag half of
 * rule 7 then says nothing, the same way rule 6 says nothing with no base ref.
 * Annotated and lightweight tags both resolve to the same commit, so only the
 * name matters here.
 * @returns the tag names, or an empty list.
 */
function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list', '--sort=-v:refname'], {
      cwd: new URL('.', root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
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
// CHANGELOG.md is a historical record of when the phases happened, so it is the
// only legitimate citation left. New prose must not reintroduce the numbering.
const phaseExempt = new Set(['CHANGELOG.md'])
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
//    `src/config.ts`), so the list below is the schema's default — kept here as a
//    copy because a fresh clone has no build output to import it from, and
//    proven against the built schema below so the copy cannot drift.
const mirrors = [
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
//    The copy above is only safe while it says the same thing as the schema, so
//    when a build is present the two are compared. `prepack` builds before it
//    runs this script, and CI builds first; a plain clone has no `lib/`, and the
//    comparison is skipped rather than guessed.
if (existsSync(new URL('lib/config.js', root))) {
  const { Config } = await import(new URL('lib/config.js', root).href)
  const schema = Config({}).docs.mirrors.get()
  const asText = (groups) => groups.map((group) => group.join('|')).join(',')
  if (asText(schema) !== asText(mirrors)) {
    failures.push(
      `scripts/ci-checks.mjs: mirrors copy disagrees with src/config.ts (schema has ${asText(schema)})`,
    )
  }
}
ok(`mirrored pairs consistent (${mirrors.length} groups)`, before)

// 7. Version alignment. The titled heading is what the release notes point at,
//    so a version without one is a release nobody can read about — and a tag
//    without one is a release that already happened and cannot be described.
before = mark()
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')

/** Does CHANGELOG.md carry a `## [<version>]` heading for this version? */
function hasSection(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^##\\s+\\[?v?${escaped}\\]?\\b`, 'm').test(changelog)
}

if (!hasSection(pkg.version)) {
  failures.push(`CHANGELOG.md: no section for the released version ${pkg.version}`)
}
const tags = gitTags()
for (const tag of tags) {
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || hasSection(tag.replace(/^v/, ''))) {
    continue
  }
  failures.push(`CHANGELOG.md: no section for the tag ${tag}`)
}
ok(
  tags.length > 0
    ? `CHANGELOG records ${pkg.version} and every one of ${tags.length} tags`
    : `CHANGELOG records ${pkg.version} (no tags to compare with)`,
  before,
)

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
//    cheaper than remembering to edit both. The second half closes the range: an
//    open upper bound claims compatibility with versions that do not exist yet,
//    and the claim is only discovered to be false at runtime, in someone else's
//    profile.
before = mark()
const enginesDsh = pkg.engines?.dsh
const peerDsh = pkg.peerDependencies?.['@deepseek-ai/dsh']
if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') {
  failures.push('package.json: engines.dsh is not declared (DSH falls back to the peer ranges)')
} else if (enginesDsh !== peerDsh) {
  failures.push(
    `package.json: engines.dsh (${enginesDsh}) and the @deepseek-ai/dsh peer (${peerDsh}) disagree`,
  )
} else if (!/<\d+\.\d+\.\d+/.test(enginesDsh)) {
  failures.push(
    `package.json: engines.dsh (${enginesDsh}) has no upper bound, so it admits DSH versions ` +
      `this plugin was never tested against — write the range as ">=<floor> <ceiling>"`,
  )
}
ok('DSH requirement declared consistently, and closed above', before)

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

// 11. A user-visible change and its changelog entry travel in the same pull
//     request. Squash merging means the pull request title *is* the commit
//     message, so `feat:` and `fix:` are that author's own claim that a user
//     can observe something different — and the entry is what the release page
//     is copied from, written at the one moment the author still remembers
//     why. A change under `src/` with no feat/fix title is the same claim by
//     location: anything a user can install came out of `src/`.
before = mark()
const prTitle = (process.env.PR_TITLE ?? '').trim()
const claimed = /^(?:feat|fix)(?:\([^)]*\))?!?:/.test(prTitle)
const touchesSource = [...changed].some((file) => file.startsWith('src/'))
if (changed.size > 0 && !changed.has('CHANGELOG.md')) {
  if (claimed) {
    failures.push(
      `${prTitle.split(':')[0]}: the title claims a user-visible change but CHANGELOG.md ` +
        `is not in the diff`,
    )
  } else if (touchesSource) {
    warnings.push(
      'src/ changed without CHANGELOG.md: if a user can tell the difference, ' +
        'add an [Unreleased] entry',
    )
  }
}
ok(prTitle ? `CHANGELOG pairs with "${prTitle}"` : 'CHANGELOG pairs with the changed paths', before)

// 12. The link definitions at the bottom are the release pages' only source for
//     their `Full Changelog:` line. A copied definition keeps the previous
//     version's edges, which renders as a working link to the wrong diff — the
//     one failure mode that looks correct in review.
before = mark()
const released = [...changelog.matchAll(/^##\s+\[?(v?\d+\.\d+\.\d+)\]?/gm)].map((m) =>
  m[1].replace(/^v/, ''),
)
const definitions = new Map()
for (const match of changelog.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)) {
  definitions.set(match[1].replace(/^v/, ''), match[2])
}
for (const [index, version] of released.entries()) {
  const link = definitions.get(version)
  if (link === undefined) {
    failures.push(`CHANGELOG.md: [${version}] has no link definition at the bottom`)
    continue
  }
  const previous = released[index + 1]
  if (previous !== undefined && !link.includes(`v${previous}...v${version}`)) {
    failures.push(
      `CHANGELOG.md: [${version}] does not compare from v${previous} (links to ${link})`,
    )
  }
  if (previous === undefined && !link.includes(`v${version}`)) {
    failures.push(`CHANGELOG.md: [${version}] link does not point at v${version}`)
  }
}
ok(`CHANGELOG link definitions match their compare ranges (${released.length} released)`, before)

// 13. A CJK character in an English surface means someone edited the wrong
//     file: an English reader is then shown Chinese, and rule 1 cannot see it
//     because the key sets still line up. The two English surfaces are the
//     shipped dictionary and the web client's `EN` block. In `src/` the
//     character is fine in a comment (several quote a Chinese heading as an
//     example of a configurable value) and never fine in code, where
//     user-visible text has to come from `t()`. `pre-pr.ts` is exempt: it
//     matches what a user typed and never prints it.
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/
const CJK_CODE_EXEMPT = new Set(['src/triggers/pre-pr.ts'])
before = mark()
const englishSurfaces = [readFileSync(new URL('locale/en.json', root), 'utf8')]
const client = readFileSync(new URL('client.js', root), 'utf8')
const englishBlock = client.slice(client.indexOf('const EN = {'), client.indexOf('const ZH = {'))
if (englishBlock.length > 0) englishSurfaces.push(englishBlock)
for (const [index, surface] of englishSurfaces.entries()) {
  const line = surface.split(/\r?\n/).findIndex((entry) => CJK.test(entry))
  if (line !== -1) {
    failures.push(
      `${index === 0 ? 'locale/en.json' : 'client.js (EN block)'}:${line + 1} contains CJK: ` +
        'the English surface is showing Chinese',
    )
  }
}
/** Every tracked `.ts` file under `src/`, as repository-relative paths. */
function trackedSource(directory = 'src/') {
  const found = []
  for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
    const relative = `${directory}${entry.name}`
    if (entry.isDirectory()) found.push(...trackedSource(`${relative}/`))
    else if (entry.name.endsWith('.ts')) found.push(relative)
  }
  return found
}
for (const file of trackedSource()) {
  if (CJK_CODE_EXEMPT.has(file)) continue
  const lines = readFileSync(new URL(file, root), 'utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!CJK.test(line)) continue
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    failures.push(`${file}:${index + 1} has CJK outside a comment: ${line.trim()}`)
    break
  }
}
ok('English surfaces carry no CJK', before)

// 14. See the header. The example block in the publishing guide is the only
//     release page a checkout can see, and the versions it names have to agree
//     with each other and with CHANGELOG.md. Rule 12 already read the released
//     versions, so the expected compare range is history, not a fourth copy of
//     the version list.
before = mark()
const publishing = readFileSync(new URL('docs/PUBLISHING.md', root), 'utf8')
const anchors = [...publishing.matchAll(/<h3 id="(cn|en)-v?(\d+\.\d+\.\d+)">/g)]
const languages = new Set(anchors.map((anchor) => anchor[1]))
const templateVersions = new Set(anchors.map((anchor) => anchor[2]))
const templateVersion = [...templateVersions][0]
const templatePrevious =
  templateVersion === undefined ? undefined : released[released.indexOf(templateVersion) + 1]
const trail = /^Full Changelog: \[v(\d+\.\d+\.\d+)\.\.\.v(\d+\.\d+\.\d+)\]\((\S+)\)$/m.exec(
  publishing,
)
if (languages.size !== 2 || templateVersions.size !== 1) {
  failures.push(
    'docs/PUBLISHING.md: the release page template has ' +
      anchors.length +
      ' language anchors (' +
      ([...templateVersions].join(', ') || 'none') +
      ') - it needs one per language and both must name the same version',
  )
} else if (!released.includes(templateVersion)) {
  failures.push(
    'docs/PUBLISHING.md: the release page template names v' +
      templateVersion +
      ', which has no section in CHANGELOG.md',
  )
} else if (trail === null) {
  failures.push('docs/PUBLISHING.md: the release page template has no closing Full Changelog line')
} else if (trail[2] !== templateVersion) {
  failures.push(
    'docs/PUBLISHING.md: the template Full Changelog line ends at v' +
      trail[2] +
      ', but its headings name v' +
      templateVersion,
  )
} else if (templatePrevious !== undefined && trail[1] !== templatePrevious) {
  failures.push(
    'docs/PUBLISHING.md: the template compares from v' +
      trail[1] +
      ', but v' +
      templateVersion +
      ' follows v' +
      templatePrevious +
      ' in CHANGELOG.md',
  )
} else if (!trail[3].endsWith('/compare/v' + trail[1] + '...v' + trail[2])) {
  failures.push(
    'docs/PUBLISHING.md: the template link (' + trail[3] + ') does not point at the range it names',
  )
}
ok('release page template keeps both languages and the right compare range', before)

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  process.exit(1)
}
for (const warning of warnings) console.warn(`warning: ${warning}`)
