import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Config } from './config.js'
import type { Translate } from './i18n.js'
import type { CheckResult } from './tools/result.js'
import { checkCommitMessage } from './tools/check-commit-message.js'
import { checkDocSync } from './tools/check-doc-sync.js'

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

const OPERATORS = new Set(['&&', '||', ';', '|', '\n'])

/**
 * Split a shell command into words, resolving quotes and escaping. Separators
 * survive as their own token so command boundaries can be recovered.
 * @param command - the command line.
 * @returns the tokens, in order.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  const flush = (): void => {
    if (!started) return
    tokens.push(current)
    current = ''
    started = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    const next = command.charAt(index + 1)
    if (quote !== null) {
      if (char === quote) {
        quote = null
        started = true
        continue
      }
      // A single-quoted shell string takes backslashes literally; a double
      // quoted one lets them escape the next character.
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += next
        index += 1
      } else {
        current += char
      }
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += next
      index += 1
      started = true
      continue
    }
    if (char === '\n') {
      flush()
      tokens.push('\n')
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      flush()
      continue
    }
    if (char === '&' && next === '&') {
      flush()
      tokens.push('&&')
      index += 1
      continue
    }
    if (char === '|' && next === '|') {
      flush()
      tokens.push('||')
      index += 1
      continue
    }
    if (char === '|' || char === ';') {
      flush()
      tokens.push(char)
      continue
    }
    // Subshell and group delimiters only matter for where a command starts.
    if (char === '(' || char === ')' || char === '{' || char === '}') {
      flush()
      continue
    }
    current += char
    started = true
  }
  flush()
  return tokens
}

/**
 * Cut a token stream at its operators.
 * @param tokens - tokens from {@link tokenize}.
 * @returns one word list per command.
 */
function segments(tokens: readonly string[]): string[][] {
  const result: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      if (current.length > 0) result.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) result.push(current)
  return result
}

/** Git options that take a separate value, so it is not mistaken for a command. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
])

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
  for (const word of segments(tokenize(command))) {
    let index = 0
    while (index < word.length) {
      const token = word[index] ?? ''
      // Leading `VAR=value` assignments and `env` are not the command itself.
      if (token === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1
        continue
      }
      break
    }
    const program = word[index]
    if (program === undefined) continue
    const base = program.replace(/\\/g, '/').split('/').pop() ?? program
    if (base !== 'git' && base !== 'git.exe') continue

    index += 1
    while (index < word.length) {
      const token = word[index] ?? ''
      if (GIT_VALUE_OPTIONS.has(token)) {
        index += 2
        continue
      }
      if (token.startsWith('-')) {
        index += 1
        continue
      }
      break
    }
    if (word[index] !== 'commit') continue
    return commitArguments(word.slice(index + 1))
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

  if (input.files !== undefined) {
    const docs = checkDocSync({ files: input.files }, config, t)
    errors.push(...docs.errors)
    warnings.push(...docs.warnings)
  }

  if (input.message !== undefined) {
    const commit = checkCommitMessage(
      { message: input.message, ...(input.files === undefined ? {} : { files: input.files }) },
      t,
    )
    errors.push(...commit.errors)
    warnings.push(...commit.warnings)

    const type = /^([a-z]+)/.exec(input.message)?.[1]
    if (
      config.rules.requireChangelogOnFeat &&
      input.files !== undefined &&
      type === 'feat' &&
      !input.files.includes(config.docs.changelog)
    ) {
      // The documentation check already says this softly. The repository rule
      // makes it blocking for a feature, so the advisory line is replaced
      // rather than repeated.
      const advisory = t('tool.check_doc_sync.warn.changelog', {
        changelog: config.docs.changelog,
      })
      const index = warnings.indexOf(advisory)
      if (index !== -1) warnings.splice(index, 1)
      errors.push(
        t('tool.check_commit_message.error.changelog_required', {
          changelog: config.docs.changelog,
        }),
      )
    }
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
