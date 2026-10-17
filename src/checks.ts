import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CONFIG_FILES } from './config.js'
import type { Config } from './config.js'
import type { GitRunner } from './git.js'
import type { Translate } from './i18n.js'
import type { CheckResult } from './tools/result.js'
import { checkCommitMessage } from './tools/check-commit-message.js'
import { checkDocSync } from './tools/check-doc-sync.js'
import { quoteCommandWords, shellWordIsLiteral, subcommandWords, wordInvocations } from './shell.js'
import type { CommandWord } from './shell.js'

// Inspection of one change, shared by the pre-commit trigger and the
// `/dev-workflow check` command. The working tree is read once by the caller, so
// the rules below are pure functions of a path list and a message — which is
// also what lets the trigger render the same findings in two languages.

/** A shell command that creates a commit. */
export interface CommitCommand {
  /** The message, when the command line states it. */
  readonly message?: string
  /** Path given to `-F`/`--file`, as written on the command line. */
  readonly file?: string
  /**
   * Whether the command amends the previous commit instead of creating one.
   * Under `--amend` the message is whatever the editor or `-m` supplies, so a
   * command that states none still has a message worth checking.
   */
  readonly amend?: boolean
  /**
   * A message the command names in a form this check cannot read.
   *
   * `git commit -m "$msg"`, `-F` with a file another part of the same command
   * line writes, and `-F -` all land here. They are reported, not ignored: a
   * check that could not read the message must not be mistaken for one that
   * read it and approved.
   */
  readonly unreadable?: string
}

/** What one inspection covers. Omit a field to skip its rules. */
export interface EvaluationInput {
  /** The commit message to check. */
  readonly message?: string
  /** The repository-relative paths the change touches. */
  readonly files?: readonly string[]
  /**
   * Paths the branch already carries, when the caller knows them. A rule that
   * asks "was this documented with the change?" is answered by the branch, not
   * by whichever commit is being made now.
   */
  readonly branchFiles?: readonly string[]
  /** Paths the working tree has changed outside this commit — see {@link DocSyncInput.worktreeFiles}. */
  readonly worktreeFiles?: readonly string[]
}

/**
 * Whether a command-line value is text the check can actually read.
 *
 * A command substitution has an unknown value by the time the check runs, and a
 * parameter expansion names one rather than being one. Treating either as "no
 * message readable" is better than checking a literal `$(...)` and blocking a
 * commit over text git will never see — but it is also why the caller has to
 * report *that* it could not read the value, rather than passing in silence.
 *
 * Quoting decides the rest. `'$(cat m)'` is a value the shell is about to expand
 * and a check cannot know; the same text inside a single-quoted word is what git
 * will record. {@link quoteCommandWords} keeps that distinction per word, and
 * this is the one predicate the checks read it through.
 * @param word - one word of a command line.
 * @returns whether the word is literal text.
 */
export function isLiteral(word: CommandWord): boolean {
  return shellWordIsLiteral(word)
}

/**
 * Read the message arguments of a `git commit`.
 * @param args - the words after `commit`, each saying how it was written.
 * @returns what the command line states, if anything.
 */
function commitArguments(args: readonly CommandWord[]): CommitCommand {
  const messages: string[] = []
  let file: string | undefined
  let amend = false
  let unreadable: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]
    const token = word?.value ?? ''
    if (token === '--amend') amend = true
    if (!token.startsWith('-') || token === '--' || token === '-') continue

    // A long option names itself and may carry its value after `=`, which is how
    // `--message="…"` and `--file=…` are usually written. Reading only the bare
    // spelling let both forms name a message the check never saw.
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token : token.slice(0, equals)
      if (name !== '--message' && name !== '--file') continue
      let value: CommandWord | undefined
      if (equals === -1) {
        index += 1
        value = args[index]
      } else {
        // Attached text inherits the quoting of the word it was cut from, so a
        // substitution still reads as one: `--message=$(cat m)` is unreadable.
        value = { value: token.slice(equals + 1), literal: word?.literal ?? false }
      }
      if (value === undefined) break
      if (name === '--message') {
        if (isLiteral(value)) messages.push(value.value)
        else unreadable = value.value
      } else {
        // Kept even when the word is not literal text: the caller has to be able
        // to say that a message was named but could not be read.
        file = value.value
      }
      continue
    }

    // A short cluster is read letter by letter, so `-am "msg"` and `-m "msg"` are
    // the same command. The first letter that takes a value consumes the rest of
    // the cluster, or the next word.
    const letters = [...token.slice(1)]
    for (let position = 0; position < letters.length; position += 1) {
      const name = letters[position] ?? ''
      const rest = token.slice(2 + position)
      // A value attached to the letter is part of this word, and inherits its
      // quoting: `-mfeat: x` is text git will record, `-m$(cat m)` is not.
      const inline: CommandWord | undefined =
        rest.length > 0 ? { value: rest, literal: word?.literal ?? false } : args[index + 1]
      if (name !== 'm' && name !== 'F') continue
      if (rest.length === 0) index += 1
      if (inline === undefined) break
      if (name === 'm') {
        if (isLiteral(inline)) messages.push(inline.value)
        else unreadable = inline.value
      } else {
        file = inline.value
      }
      break
    }
  }

  // Git joins repeated `-m` bodies as separate paragraphs.
  if (messages.length > 0) {
    return { message: messages.join('\n\n'), ...(amend ? { amend } : {}) }
  }
  if (file !== undefined) return { file, ...(amend ? { amend } : {}) }
  return { ...(amend ? { amend } : {}), ...(unreadable === undefined ? {} : { unreadable }) }
}

/**
 * Recognise a `git commit` in one shell command.
 * @param command - a shell command line, as a tool would receive it.
 * @returns the commit when the command creates one, otherwise `undefined`.
 */
export function detectCommit(command: string): CommitCommand | undefined {
  const words = quoteCommandWords(command)
  for (const invocation of wordInvocations(words)) {
    if (invocation.program !== 'git' && invocation.program !== 'git.exe') continue
    const commit = subcommandWords(invocation.args)
    if (commit === undefined || commit.subcommand !== 'commit') continue
    return commitArguments(commit.args)
  }
  return undefined
}

/**
 * Resolve the message a command will commit with.
 *
 * The distinction between "no message to read" and "a message that cannot be
 * read yet" is kept, because they are different answers: `git commit --amend`
 * opens the editor, while `echo x > m && git commit -F m` writes the file later
 * in the same command line, and a check that runs before the write must say it
 * could not read the message rather than behaving as if there were none.
 * @param commit - what {@link detectCommit} found.
 * @param cwd - the working directory the command runs in.
 * @returns the message and whether an unreadable one was named.
 */
export async function resolveCommitMessage(
  commit: CommitCommand,
  cwd: string,
): Promise<{ readonly message?: string; readonly unreadable?: string }> {
  if (commit.message !== undefined) return { message: commit.message }
  if (commit.unreadable !== undefined) return { unreadable: commit.unreadable }
  if (commit.file === undefined) return {}
  if (commit.file === '-') return { unreadable: '-' }
  const path = isAbsolute(commit.file) ? commit.file : join(cwd, commit.file)
  try {
    return { message: await readFile(path, 'utf8') }
  } catch {
    return { unreadable: commit.file }
  }
}

/**
 * Read the message of the commit `--amend` would rewrite.
 *
 * Amending is the moment the message is most likely to be rewritten with a
 * hand-typed summary, and the command line names no message at all: without
 * this, repairing a message would be the one path the message rules never see.
 * @param run - a git runner bound to the working directory.
 * @param signal - cancellation for the read.
 * @returns the message git would open in the editor, or `undefined`.
 */
export async function amendedMessage(
  run: GitRunner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await run.run(['log', '-1', '--format=%B'], signal)
  if (!result.ok) return undefined
  const message = result.stdout.trim()
  return message.length === 0 ? undefined : message
}

/**
 * Judge one message against the commit-message rules, applying the gate's own
 * policy.
 *
 * `commitCheck.enabled` and `commitCheck.onFailure` belong to the rule, not to
 * the entry point that happens to run it: a pull request title is the commit
 * message under squash merge, so a repository that turned the check off or
 * downgraded it to a warning did so for that text too.
 * @param message - the message to judge.
 * @param files - the change the message describes, when known.
 * @param config - resolved plugin configuration.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function evaluateMessage(
  message: string,
  files: readonly string[] | undefined,
  config: Config,
  t: Translate,
): CheckResult {
  if (!config.commitCheck.enabled.get()) return { ok: true, errors: [], warnings: [] }
  const check = checkCommitMessage(
    { message, ...(files === undefined ? {} : { files }) },
    config,
    t,
  )
  return config.commitCheck.onFailure.get() === 'warn'
    ? { ok: true, errors: [], warnings: [...check.errors, ...check.warnings] }
    : { ok: check.errors.length === 0, errors: check.errors, warnings: check.warnings }
}

/**
 * Judge one change against the workflow rules.
 * @param input - the message and paths known about the change.
 * @param config - resolved plugin configuration.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function evaluate(input: EvaluationInput, config: Config, t: Translate): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (input.files !== undefined && config.docsCheck.enabled.get()) {
    const docs = checkDocSync(
      {
        files: input.files,
        ...(input.worktreeFiles === undefined ? {} : { worktreeFiles: input.worktreeFiles }),
      },
      config,
      t,
    )
    errors.push(...docs.errors)
    warnings.push(...docs.warnings)

    const readme = [...config.docs.readme.get()]
    if (
      config.docsCheck.requireReadmeOnConfig.get() &&
      input.files.some((path) => (CONFIG_FILES as readonly string[]).includes(path)) &&
      !input.files.some((path) => readme.includes(path))
    ) {
      warnings.push(
        t('tool.check_doc_sync.warn.readme_on_config', { files: CONFIG_FILES.join(', ') }),
      )
    }

    const type = input.message === undefined ? undefined : /^([a-z]+)/.exec(input.message)?.[1]
    const changelog = config.docs.changelog.get()
    // "Carried by this change" is satisfied by the change under review or by an
    // earlier commit on the branch. A feature built over several commits updates
    // the changelog once, and the rule is about the branch, not the commit that
    // happens to be the last one.
    const carriesChangelog =
      input.files.includes(changelog) || (input.branchFiles ?? []).includes(changelog)
    if (config.rules.requireChangelogOnFeat.get() && type === 'feat' && !carriesChangelog) {
      // The documentation check already says this softly. The repository rule
      // makes it blocking for a feature, so the advisory line is replaced
      // rather than repeated.
      const advisory = t('tool.check_doc_sync.warn.changelog', { changelog })
      const index = warnings.indexOf(advisory)
      if (index !== -1) warnings.splice(index, 1)
      errors.push(t('tool.check_commit_message.error.changelog_required', { changelog }))
    }
  }

  if (input.message !== undefined) {
    const judged = evaluateMessage(input.message, input.files, config, t)
    errors.push(...judged.errors)
    warnings.push(...judged.warnings)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Reduce an outcome to the one line the status surface shows.
 *
 * The status line has room for one sentence, and the first error is the one the
 * author has to fix first — but a count is appended when there are more, because
 * a summary that silently reports one of three problems reads as "one problem".
 * @param outcome - what a check found.
 * @param t - translator for the all-clear and the count lines.
 * @returns the first blocking problem, with a count when others were also found.
 */
export function summarize(outcome: CheckResult, t: Translate): string {
  const first = outcome.errors[0]
  if (first === undefined) return t('command.toggle.check.clean')
  const others = outcome.errors.length - 1
  if (others === 0) return first
  return `${first} ${t('command.toggle.check.more', { count: others })}`
}

/**
 * Digest one checked target, for "already reported in this session".
 * @param value - what was checked.
 * @returns eight hexadecimal digits.
 */
export function fingerprint(value: string): string {
  // FNV-1a: short, stable, and dependency-free. Collisions only cost a missed
  // repeat prompt, so a non-cryptographic hash is the right size here.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
