// CI guardrails that need no third-party dependency.
//
// 1. The shipped locale dictionaries must expose exactly the same key set.
//    CI checks that the keys line up; whether a translation is *correct* is a
//    human review item and cannot be automated here.
// 2. The bundle manifest must ship cordis.patch.yml, or the patch never applies.
//    `dsh.bundle.patch` is read from package.json and resolved relative to the
//    package directory, so both the pointer and the file have to line up.

import { readFileSync, existsSync } from 'node:fs'

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

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  process.exit(1)
}

console.log(`locale keys aligned (${en.size} keys); bundle patch declared and shipped.`)
