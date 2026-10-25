import type { GitRunner } from '../git.js'

// Whether this branch and another one in flight would conflict.
//
// Two branches opened from the same base both append to the same region of the
// changelog. Each is clean on its own, so nothing here complains until the
// second one is merged — by which point the author has already reviewed, waited
// for CI, and answered "why does this conflict, it passed a minute ago".
//
// `git merge-tree --write-tree` answers the question without touching the
// working tree, the index, or the network: it writes the merged tree into the
// object database and names the paths that did not merge. That makes it safe to
// run before a command that only opens a pull request.

/** A local branch this one would conflict with once both are merged. */
export interface PendingConflict {
  /** The local branch name. */
  readonly branch: string
  /** The paths the two branches disagree on. */
  readonly files: readonly string[]
}

/**
 * How many sibling branches one call will look at.
 *
 * Every branch already merged into `HEAD` is dropped before the count, so this
 * only bounds a repository with many branches in flight at once. The cap exists
 * because each candidate costs one subprocess.
 */
const MAX_SIBLINGS = 5

/**
 * Note a conflicting branch only while the list stays short enough to read.
 *
 * A prompt listing ten branches is a prompt nobody reads, and the first one
 * named is as actionable as all ten: resolving against it re-runs the check.
 */
const MAX_REPORTED = 2

/**
 * Trunk names to fall back on when the remote never told us which one it is.
 *
 * Ordered by how often they are a repository's trunk, and only ever used when
 * the branch actually exists. A repository whose trunk is none of these simply
 * gets no target and is checked against every branch, which is the old
 * behaviour.
 */
const CONVENTIONAL_TRUNKS = ['main', 'master'] as const

/**
 * Name the branch this one is expected to merge into, if it can be told.
 *
 * The branch everybody merges into is not a sibling: being behind it is the
 * ordinary state of a working branch, and reporting it here would fire on nearly
 * every pull request with the wrong advice. `origin/HEAD` is what the remote says
 * its default branch is, so no name is guessed.
 *
 * A clone that has never fetched has no `origin/HEAD`, so the usual names are
 * tried next. Guessing wrong only costs a missed warning on a repository that
 * named its trunk something unheard of — the reverse mistake, warning about the
 * trunk on every stale branch, is the one worth avoiding.
 * @param git - the runner for the working directory.
 * @param signal - caller-owned cancellation.
 * @returns the short branch name, or `undefined` when none could be found.
 */
async function integrationBranch(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await git.run(['rev-parse', '--abbrev-ref', 'origin/HEAD'], signal)
  if (result.ok) {
    const name = result.stdout.trim().replace(/^origin\//, '')
    if (name.length > 0) return name
  }
  const local = await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], signal)
  if (!local.ok) return undefined
  const branches = local.stdout.split('\n').map((line) => line.trim())
  return CONVENTIONAL_TRUNKS.find((name) => branches.includes(name))
}

/**
 * Name the local branches this one would conflict with.
 *
 * A branch already merged into `HEAD` cannot conflict with it, and the branch
 * this one is heading for is not a sibling — so only the unmerged, non-target
 * ones are candidates. Branches only this machine has are enough: work that is
 * still local is work whose merge order is still open.
 * @param git - the runner for the working directory.
 * @param signal - caller-owned cancellation.
 * @returns the conflicting branches, capped at {@link MAX_REPORTED}.
 */
export async function conflictingBranches(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<readonly PendingConflict[]> {
  const [current, target] = await Promise.all([
    git.run(['rev-parse', '--abbrev-ref', 'HEAD'], signal),
    integrationBranch(git, signal),
  ])
  const skip = new Set<string>([current.ok ? current.stdout.trim() : ''])
  if (target !== undefined) skip.add(target)

  const listed = await git.run(
    ['for-each-ref', '--format=%(refname:short)', '--no-merged=HEAD', 'refs/heads'],
    signal,
  )
  if (!listed.ok) return []

  const conflicts: PendingConflict[] = []
  const names = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && !skip.has(name))
    .slice(0, MAX_SIBLINGS)
  for (const name of names) {
    // A conflict is a non-zero exit with the paths on stdout, so the failure is
    // the answer here rather than an error. Anything else — no git, a directory
    // that is not a repository, an old git without `--write-tree` — is "not
    // answered", and a check that turns that into a warning teaches its reader
    // to skip warnings.
    const result = await git.run(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', name, 'HEAD'],
      signal,
    )
    if (result.ok) continue
    if (result.failure !== 'command-failed') return conflicts
    // Line 0 is the tree it wrote; the paths follow. An older git puts its
    // complaint on stderr and nothing on stdout, which yields no entry.
    const files = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(1)
    if (files.length === 0) continue
    conflicts.push({ branch: name, files })
    if (conflicts.length >= MAX_REPORTED) break
  }
  return conflicts
}
