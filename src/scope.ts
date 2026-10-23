import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// A profile is per machine, so a plugin mounted in one applies to every working
// directory that profile is used from. That is the wrong unit for a workflow
// guard: the rules are a property of the repository, not of the laptop. This
// module is the one place that answers "does this repository want the rules",
// so the answer can be given without a second copy of the configuration.

/**
 * Marker file that opts one repository in when `scope` is `marked`.
 *
 * `.dsh/` is already where DSH looks for project-level material — project
 * skills live in `.dsh/skills` — so the marker rides an existing convention
 * rather than introducing a new top-level file. Only its presence is read; the
 * contents are deliberately ignored, because a marker that cannot be
 * misconfigured is worth more than one that can.
 */
export const SCOPE_MARKER = join('.dsh', 'dev-workflow.yml')

/** Where the plugin applies. */
export type Scope = 'all' | 'marked'

// The walk is cached, the marker check is not. A working directory does not
// move during a session, so its root is a stable answer worth keeping; but the
// marker is a file someone may add while the session is running, and it has to
// take effect on the next tool call rather than on the next restart.
const roots = new Map<string, string>()

/**
 * Find the project root above a working directory.
 *
 * DSH itself walks up to the nearest `.git` and calls that the project, so the
 * plugin has to agree with it: a `marked` repository whose subdirectory was the
 * working directory must still resolve to the same root the host names.
 * @param cwd - the working directory a tool call runs in.
 * @returns the nearest ancestor carrying `.git`, or `cwd` itself when none does.
 */
export function projectRoot(cwd: string): string {
  const start = resolve(cwd)
  const cached = roots.get(start)
  if (cached !== undefined) return cached
  let current = start
  let found = start
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      found = current
      break
    }
    const parent = dirname(current)
    // The filesystem root is its own parent. DSH answers with the original
    // working directory in that case, and so does this walk.
    if (parent === current) break
    current = parent
  }
  roots.set(start, found)
  return found
}

/**
 * Whether a working directory belongs to a repository that opted in.
 * @param cwd - the working directory a tool call runs in.
 * @returns `true` when the project root carries the marker.
 */
export function marked(cwd: string): boolean {
  return existsSync(join(projectRoot(cwd), SCOPE_MARKER))
}

/**
 * Whether the plugin applies to one working directory.
 *
 * `all` returns before touching the filesystem, so the default configuration
 * pays nothing for a switch it does not use. An absent working directory means
 * the caller is not asking on behalf of a repository — the catalog can be built
 * before an agent has one — and the plugin answers as it always did.
 * @param scope - the configured scope.
 * @param cwd - the working directory a tool call runs in.
 * @returns `true` when the call should be checked.
 */
export function applies(scope: Scope, cwd: string | undefined): boolean {
  if (scope === 'all') return true
  if (cwd === undefined) return true
  return marked(cwd)
}
