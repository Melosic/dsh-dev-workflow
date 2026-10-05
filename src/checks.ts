import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CONFIG_FILES } from './config.js'
import type { Config } from './config.js'
import type { Translate } from './i18n.js'
import type { CheckResult } from './tools/result.js'
import { checkCommitMessage } from './tools/check-commit-message.js'
import { checkDocSync } from './tools/check-doc-sync.js'
import { gitInvocations } from './shell.js'

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
}

/** What one inspection covers. Omit a field to skip its rules. */
export interface EvaluationInput {
  /** The commit message to check. */
  readonly message?: string
  /** The repository-relative paths the change touches. */
  readonly files?: readonly string[]
}

/**
 * Read the message arguments of a `git commit`.
 * @param args - the words after `commit`.
 * @returns what the command line states, if anything.
 */
function commitArguments(args: readonly string[]): CommitCommand {
  const messages: string[] = []
  let file: string | undefined

  // A command substitution has an unknown value by the time the check runs;
  // treating it as "no message readable" is better than checking a literal
  // `$(...)` and blocking a commit over text git will never see.
  const literal = (value: string): boolean => !value.includes('$(') && !value.includes('`')

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    const value = args[index + 1]
    if (token === '-m' || token === '--message') {
      if (value !== undefined) {
        if (literal(value)) messages.push(value)
        index += 1
      }
      continue
    }
    if (token.startsWith('--message=')) {
      const inline = token.slice('--message='.length)
      if (literal(inline)) messages.push(inline)
      continue
    }
    if (token.startsWith('-m') && token.length > 2) {
      const inline = token.slice(2)
      if (literal(inline)) messages.push(inline)
      continue
    }
    if (token === '-F' || token === '--file') {
      if (value !== undefined) {
        if (literal(value)) file = value
        index += 1
      }
      continue
    }
    if (token.startsWith('--file=')) {
      const inline = token.slice('--file='.length)
      if (literal(inline)) file = inline
      continue
    }
    if (token.startsWith('-F') && token.length > 2) {
      const inline = token.slice(2)
      if (literal(inline)) file = inline
    }
  }

  // Git joins repeated `-m` bodies as separate paragraphs.
  if (messages.length > 0) return { message: messages.join('\n\n') }
  if (file !== undefined) return { file }
  return {}
}

/**
 * Recognise a `git commit` in one shell command.
 * @param command - a shell command line, as a tool would receive it.
 * @returns the commit when the command creates one, otherwise `undefined`.
 */
export function detectCommit(command: string): CommitCommand | undefined {
  for (const invocation of gitInvocations(command)) {
    if (invocation.subcommand === 'commit') return commitArguments(invocation.args)
  }
  return undefined
}

/**
 * Resolve the message a command will commit with.
 * @param commit - what {@link detectCommit} found.
 * @param cwd - the working directory the command runs in.
 * @returns the message, or `undefined` when git will have to ask for one.
 */
export async function resolveCommitMessage(
  commit: CommitCommand,
  cwd: string,
): Promise<string | undefined> {
  if (commit.message !== undefined) return commit.message
  if (commit.file === undefined || commit.file === '-') return undefined
  const path = isAbsolute(commit.file) ? commit.file : join(cwd, commit.file)
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
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
    const docs = checkDocSync({ files: input.files }, config, t)
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
    if (
      config.rules.requireChangelogOnFeat.get() &&
      type === 'feat' &&
      !input.files.includes(changelog)
    ) {
      // The documentation check already says this softly. The repository rule
      // makes it blocking for a feature, so the advisory line is replaced
      // rather than repeated.
      const advisory = t('tool.check_doc_sync.warn.changelog', { changelog })
      const index = warnings.indexOf(advisory)
      if (index !== -1) warnings.splice(index, 1)
      errors.push(t('tool.check_commit_message.error.changelog_required', { changelog }))
    }
  }

  if (input.message !== undefined && config.commitCheck.enabled.get()) {
    const commit = checkCommitMessage(
      { message: input.message, ...(input.files === undefined ? {} : { files: input.files }) },
      config,
      t,
    )
    warnings.push(...commit.warnings)
    // `onFailure` is the gate's policy, not the check's: a hard problem is
    // reported either way, and only here does the setting decide whether it
    // stops the commit or merely warns about it.
    if (config.commitCheck.onFailure.get() === 'warn') warnings.push(...commit.errors)
    else errors.push(...commit.errors)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Reduce an outcome to the one line the status surface shows.
 * @param outcome - what a check found.
 * @param t - translator for the all-clear line.
 * @returns the first blocking problem, or the all-clear line.
 */
export function summarize(outcome: CheckResult, t: Translate): string {
  if (outcome.ok) return t('command.toggle.check.clean')
  return outcome.errors[0] ?? t('command.toggle.check.clean')
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
