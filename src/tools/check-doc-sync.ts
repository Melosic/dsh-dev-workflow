import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { Translate } from '../i18n.js'
import type { GitRunner } from '../git.js'
import type { CheckResult } from './result.js'
import { renderCheck } from './result.js'

// Documentation sync. Only two things here are mechanical enough to block a
// change: a paired file that was left behind, and a repository-wide rule. "This
// code change ought to be described in ARCHITECTURE.md" is an editorial
// judgement, so it is reported as a warning the author can dismiss.

/** What the doc-sync rules judge: the paths a change touches, plus the paths already on the branch. */
export interface DocSyncInput {
  /** Repository-relative paths this change touches. */
  readonly files: readonly string[]
  /**
   * Paths the working tree has changed but the commit does not include.
   *
   * A mirrored document left behind is a mistake. A mirrored document whose pair
   * is sitting staged-or-dirty in the same tree is a half-finished edit, and a
   * check that cannot tell the two apart turns "come back and finish this" into a
   * wall every unrelated commit has to get past.
   */
  readonly worktreeFiles?: readonly string[]
  /**
   * Paths the repository already carries, when the caller knows them.
   *
   * A pair can only be left behind by a repository that has the pair: when one
   * half has never existed, this project does not keep that document, and
   * demanding it would stop every new repository at its first commit — that
   * commit is where both halves are `git add`ed for the first time, or neither.
   * Omit the field when the caller cannot say; every path is then assumed to
   * exist, which is the rule as it was.
   */
  readonly existing?: readonly string[]
}

/**
 * Parse the paths out of `git status --porcelain=v1 -z` output.
 *
 * `-z` matters for paths that are not ASCII: the default rendering quotes them
 * and escapes every non-ASCII byte as `\303\251`-style octal, which no rule here
 * can match against a configured document name — a change under `docs/中文.md`
 * came back as a string that matched nothing and the check reported the tree as
 * clean. `-z` emits each path raw and NUL-terminated instead. It also changes
 * the rename shape: with `-z` git prints the new path as the entry and the old
 * path as the following NUL-separated field, rather than `old -> new`.
 * @param stdout - the command's output.
 * @returns repository-relative paths, in the order git printed them.
 */
function statusEntries(stdout: string): { status: string; path: string }[] {
  const fields = stdout.split('\0')
  const entries: { status: string; path: string }[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? ''
    // A trailing empty field is the terminator, not a path.
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    entries.push({ status, path: entry.slice(3) })
    // A rename or copy prints the original path as its own field. It is not a
    // path this change touches — the entry above is the name that now exists.
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return entries
}

/**
 * Read the paths out of the entries above.
 * @param stdout - the command's output.
 * @returns repository-relative paths, in the order git printed them.
 */
function statusPaths(stdout: string): string[] {
  return statusEntries(stdout).map((entry) => entry.path)
}

/**
 * Read the paths a repository currently has changed, staged or not.
 *
 * The listing says what changed, not what exists: a path git does not mention
 * is absent from the answer whether it is tracked and untouched or never written
 * at all. Callers that need the second question read {@link listExistingFiles}.
 * @param git - the runner for the repository.
 * @param signal - caller-owned cancellation.
 * @returns repository-relative paths, or a failure to report.
 */
export async function listChangedFiles(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<{ ok: true; files: string[] } | { ok: false; failure: string; stderr: string }> {
  // `-z` so the paths arrive as themselves: see `statusPaths`.
  const result = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)
  if (!result.ok) return { ok: false, failure: result.failure, stderr: result.stderr }
  return { ok: true, files: statusPaths(result.stdout) }
}

/**
 * Read the paths the repository already carries — tracked, staged or present.
 *
 * This answers "has this document ever existed here?", which the mirrored-pair
 * rule needs and a change set cannot answer: a repository that never had
 * `README.zh.md` and one that has it and left it out of this commit produce the
 * same listing. A failure yields `undefined` rather than an empty list: an
 * unreadable tree must not be read as "nothing exists", because that would
 * quietly switch the rule off.
 * @param git - the runner for the repository.
 * @param signal - caller-owned cancellation.
 * @returns repository-relative paths, or `undefined` when they cannot be read.
 */
export async function listExistingFiles(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<readonly string[] | undefined> {
  // `--cached --others --exclude-standard`: everything tracked (in the index or
  // in HEAD, even if deleted from the working tree) plus every ignored-out file
  // that is already on disk. That is the closest a repository-relative read gets
  // to "this path is part of the project".
  const listed = await git.run(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    signal,
  )
  if (!listed.ok) return undefined
  return [...new Set(listed.stdout.split('\0').filter((path) => path.length > 0))]
}

/**
 * Read the paths staged for the next commit — what the commit about to run will
 * actually contain.
 *
 * This is the set the commit-time rules must judge. The working tree is not it:
 * a repository where edits are made continuously (and only some of them staged)
 * would otherwise fail a convention check for changes the commit does not
 * mention, and a half-finished pair of mirrored documents sitting in the tree
 * would block every unrelated commit until it was completed or stashed.
 * @param git - the runner for the repository.
 * @param signal - caller-owned cancellation.
 * @returns repository-relative paths, or a failure to report.
 */
export async function listStagedFiles(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<{ ok: true; files: string[] } | { ok: false; failure: string; stderr: string }> {
  const result = await git.run(['diff', '--cached', '--name-only', '-z'], signal)
  if (!result.ok) return { ok: false, failure: result.failure, stderr: result.stderr }
  // `-z` gives NUL-separated, unquoted paths, so a path with a space or a quote
  // arrives as itself instead of as git's quoted rendering of itself.
  const files = result.stdout.split('\0').filter((path) => path.length > 0)
  return { ok: true, files }
}

/**
 * Read the paths the branch already committed, back to where it forked.
 *
 * A rule that asks "was this documented with the change?" is answered by the
 * branch, not by whichever commit is being made now: a feature built over
 * several commits updates the changelog once. The fork point is the merge base
 * with the branch's upstream, which is the base a pull request will be judged
 * against.
 *
 * A failure yields an empty list instead of an error: this set can only lift a
 * block, so an unreadable branch must not be guessed at, and a repository with
 * no upstream is the normal state of a local branch rather than a problem to
 * report.
 * @param git - the runner for the repository.
 * @param signal - caller-owned cancellation.
 * @returns repository-relative paths, or an empty list when they cannot be read.
 */
export async function listBranchFiles(git: GitRunner, signal?: AbortSignal): Promise<string[]> {
  const base = await git.run(['merge-base', 'HEAD', '@{upstream}'], signal)
  if (!base.ok || base.stdout.trim() === '') return []
  const diff = await git.run(['diff', '--name-only', '-z', `${base.stdout.trim()}..HEAD`], signal)
  if (!diff.ok) return []
  return diff.stdout.split('\0').filter((path) => path.length > 0)
}

/**
 * Read the tracked paths a `git commit -a` would record.
 *
 * `-a` stages every tracked change at commit time, so the index is empty (or
 * stale) when the check runs and judging it would fail the commit for contents
 * it does not have. `git status --untracked-files=no` is the same set git is
 * about to stage — tracked changes, staged or not — and leaves out untracked
 * files, which `-a` does not touch.
 *
 * The listing reads the status rather than `git diff HEAD`: on a branch with no
 * commits yet there is no HEAD to diff against, and the command fails with exit
 * 128. The first commit of a brand-new repository is exactly that case, and it
 * is a commit like any other — not a failure to report.
 * @param git - the runner for the repository.
 * @param signal - caller-owned cancellation.
 * @returns repository-relative paths, or a failure to report.
 */
export async function listTrackedChanges(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<{ ok: true; files: string[] } | { ok: false; failure: string; stderr: string }> {
  const result = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=no'], signal)
  if (!result.ok) return { ok: false, failure: result.failure, stderr: result.stderr }
  return { ok: true, files: statusPaths(result.stdout) }
}

/**
 * Say whether the given paths touch exactly one half of any mirrored group.
 *
 * Callers use it to decide whether reading the tree is worth a git call: when no
 * group is half-touched, no finding can depend on what already exists, and the
 * existence set can stay unread.
 * @param files - the paths this change touches.
 * @param config - resolved plugin configuration.
 * @returns `true` when a known pairing was changed on one side only.
 */
export function splitsMirrorPair(files: Iterable<string>, config: Config): boolean {
  const changed = new Set(files)
  return config.docs.mirrors
    .get()
    .some(
      (group) =>
        group.length > 1 &&
        group.some((path) => changed.has(path)) &&
        !group.every((path) => changed.has(path)),
    )
}

/**
 * Check whether the documents a repository pairs with its code were updated.
 * @param input - the paths this change touches.
 * @param config - resolved plugin configuration.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function checkDocSync(input: DocSyncInput, config: Config, t: Translate): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const changed = new Set(input.files)
  const docsDir = config.docs.docsDir.get()
  const changelog = config.docs.changelog.get()
  const readme = [...config.docs.readme.get()]
  const codePaths = [...config.codePaths.get()]
  // Excluded prefixes are removed from the "is this a code change" question
  // before it is asked, so a tree kept under `codePaths` can opt out by path.
  const excluded = [...config.docs.exclude.get()]

  const mirrors = [...config.docs.mirrors.get()].map((group) => [...group])
  const outside = new Set(input.worktreeFiles ?? [])
  // `undefined` is the caller saying it cannot tell, and the rule then behaves as
  // it always did: every path is assumed to exist. Only a caller that read the
  // tree narrows this.
  const existing = input.existing === undefined ? undefined : new Set(input.existing)
  for (const group of mirrors) {
    const touched = group.filter((path) => changed.has(path))
    if (touched.length === 0 || touched.length === group.length) continue
    // Only a half the project already keeps can have been left behind. A missing
    // half that has never existed here is a document this project does not keep —
    // a project written in one language has no README.zh.md — and demanding it
    // would stop a brand-new repository at its very first commit.
    const missing = group.filter(
      (path) => !changed.has(path) && (existing === undefined || existing.has(path)),
    )
    if (missing.length === 0) continue
    // Every missing half is already being edited outside this commit: the pair is
    // in progress, so the finding is one line of attention rather than a refusal.
    if (missing.every((path) => outside.has(path))) {
      warnings.push(
        t('tool.check_doc_sync.warn.mirror_pending', {
          changed: touched.join(', '),
          missing: missing.join(', '),
        }),
      )
      continue
    }
    errors.push(
      t('tool.check_doc_sync.error.mirror', {
        changed: touched.join(', '),
        missing: missing.join(', '),
      }),
    )
  }

  const code = input.files.filter(
    (path) =>
      !excluded.some((prefix) => path.startsWith(prefix)) &&
      codePaths.some((prefix) => path.startsWith(prefix)) &&
      !path.startsWith(docsDir),
  )
  const documents = [...changed].filter(
    (path) => path.startsWith(docsDir) || readme.includes(path) || path === changelog,
  )

  if (code.length > 0 && documents.length === 0) {
    warnings.push(
      t('tool.check_doc_sync.warn.no_document', {
        count: code.length,
        example: code[0]!,
        docsDir,
      }),
    )
  }
  if (code.length > 0 && !changed.has(changelog)) {
    warnings.push(t('tool.check_doc_sync.warn.changelog', { changelog }))
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Build the `check_doc_sync` tool.
 * @param options - the active translator, configuration, and a git runner bound
 *   to the caller's working directory.
 * @param options.t - translator for parameters, descriptions, and output.
 * @param options.config - resolved plugin configuration.
 * @param options.git - runner used when the caller does not pass explicit paths.
 * @returns the registry-ready tool definition.
 */
export function createCheckDocSyncTool(options: {
  t: () => Translate
  config: () => Config
  git: (cwd: string) => GitRunner
}) {
  return defineTool({
    name: 'check_doc_sync',
    description: options.t()('tool.check_doc_sync.description'),
    parameters: {
      files: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: options.t()('tool.check_doc_sync.param.files'),
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' as const, required: true as const },
          errors: {
            type: 'array' as const,
            required: true as const,
            items: { type: 'string' as const },
          },
          warnings: {
            type: 'array' as const,
            required: true as const,
            items: { type: 'string' as const },
          },
          error: { type: 'string' as const },
        },
      },
      render: (args, value) => {
        void args
        return renderCheck(
          {
            ok: value.ok,
            errors: value.errors,
            warnings: value.warnings,
            ...(value.error === undefined ? {} : { error: value.error }),
          },
          options.t(),
          'tool.check_doc_sync.ok',
        )
      },
    },
    execute: async (args, exec) => {
      const t = options.t()
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()

      let files = args.files
      if (files === undefined) {
        const listed = await listChangedFiles(options.git(cwd), exec.signal)
        if (!listed.ok) {
          return {
            ok: false,
            errors: [],
            warnings: [],
            error: t(`error.${listed.failure.replace(/-/g, '_')}`, {
              detail: listed.stderr.trim(),
            }),
          }
        }
        files = listed.files
      }
      const config = options.config()
      // Answered only when a split pairing makes it matter, so an ordinary check
      // still costs the one git read it always did.
      const existing = splitsMirrorPair(files, config)
        ? await listExistingFiles(options.git(cwd), exec.signal)
        : undefined
      return checkDocSync({ files, ...(existing === undefined ? {} : { existing }) }, config, t)
    },
  })
}
