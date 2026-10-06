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

import { readFileSync, readdirSync, existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, root), 'utf8'))

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

const locales = ['locale/en.json', 'locale/zh.json']
const keySets = locales.map((file) => new Set(keyPaths(readJson(file))))
const [en, zh] = keySets
for (const key of en) if (!zh.has(key)) failures.push(`${locales[1]} is missing key "${key}"`)
for (const key of zh) if (!en.has(key)) failures.push(`${locales[0]} is missing key "${key}"`)

const skillFiles = ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md']

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

// 4. Phase-number citations, as described above. Walking the repository also
//    covers `.dev-docs/`, where the numbering is actually defined, so that
//    directory is skipped explicitly.
const PHASE = /第\s*[0-9一二三四五六七八九十]+\s*阶段/
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

const pkg = readJson('package.json')
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

// 5. The tarball must contain the files the host actually loads. `lib/` is a
//    build output: it is gitignored and absent from a fresh clone, so packing
//    without building first produces an installable package whose entry point
//    does not exist. `prepack` runs the build and this check in that order.
//    The check is done against the filesystem and the `files` whitelist rather
//    than by shelling out to `npm pack --dry-run --json`: prepack calls this
//    script, so packing from inside it would recurse. Existence plus whitelist
//    coverage is what the tarball listing would prove.
/** Entries in `files`: a trailing slash is a directory prefix, otherwise exact. */
const shipped = ['lib/index.js', 'client.js', 'locale/en.json', 'skills/dsh-dev-workflow/SKILL.md']
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

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  process.exit(1)
}

console.log(
  `locale keys aligned (${en.size} keys); bundle patch declared and shipped; ` +
    `skill headings aligned (${enShape.length} sections); ` +
    `published entry points present (${shipped.length} checked); ` +
    `no numbered development phases cited.`,
)
