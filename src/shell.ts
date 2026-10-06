// Reading shell command lines without running a shell.
//
// Every automatic check needs this: the pre-commit trigger asks "does this line
// create a commit?", the release trigger asks "does this line tag or publish?",
// and the git guard asks "does this line destroy work?". They must agree on
// where one command ends and the next begins, so the lexing lives here rather
// than in any of them.

/** Tokens that end one command and begin another. */
const OPERATORS = new Set(['&&', '||', ';', '|', '\n'])

/**
 * Program names that only wrap the real command, so the command line still
 * starts at what follows them: `sudo rm -rf /` starts at `rm`, and
 * `sudo git push --force` is still a `git push`. Recognising them is what keeps
 * a wrapper from hiding a command from every check that reads this stream.
 */
export const TRANSPARENT = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'command',
  'exec',
  'time',
  'npx',
])

/** A leading `VAR=value` assignment, as in `FOO=1 rm -rf /`. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The base name of a program word: `/usr/bin/git` becomes `git`. */
export function baseName(word: string): string {
  return word.replace(/\\/g, '/').split('/').pop() ?? word
}

/**
 * Drop the wrappers and assignments in front of the real program.
 * @param words - one command's words.
 * @returns the index of the word the command really starts at.
 */
export function skipWrappers(words: readonly string[]): number {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (TRANSPARENT.has(baseName(word)) || ASSIGNMENT.test(word)) {
      index += 1
      continue
    }
    break
  }
  return index
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
 * Split a shell command into words, resolving quotes and escaping. Separators
 * survive as their own token so command boundaries can be recovered.
 * @param command - the command line.
 * @returns the tokens, in order.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  let expansion = false

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
    // A `${...}` parameter expansion is one word, so its braces are part of it.
    if (char === '{' && current.endsWith('$')) {
      expansion = true
      current += char
      continue
    }
    if (char === '}' && expansion) {
      expansion = false
      current += char
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
export function segments(tokens: readonly string[]): string[][] {
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

/** One external program found in a shell command line. */
export interface ProgramInvocation {
  /** The program's base name, e.g. `git` for `/usr/bin/git`. */
  readonly program: string
  /** Every word after it, options included. */
  readonly args: readonly string[]
}

/**
 * Find each program a shell command line starts, one per segment.
 *
 * Leading `VAR=value` assignments and the wrappers in {@link TRANSPARENT} are
 * skipped, because none of them is the command itself. Options are left in
 * place; only callers that know a specific program can tell which of them take
 * a value.
 * @param command - a shell command line, as a tool would receive it.
 * @returns one entry per command, in order.
 */
export function programInvocations(command: string): ProgramInvocation[] {
  const found: ProgramInvocation[] = []
  for (const words of segments(tokenize(command))) {
    const index = skipWrappers(words)
    const program = words[index]
    if (program === undefined) continue
    found.push({ program: baseName(program), args: words.slice(index + 1) })
  }
  return found
}

/** One `git <subcommand>` found in a shell command line. */
export interface GitInvocation {
  /** The subcommand, e.g. `push` or `commit`. */
  readonly subcommand: string
  /** The words after it. */
  readonly args: readonly string[]
}

/**
 * Find every `git` invocation in a shell command.
 * @param command - a shell command line, as a tool would receive it.
 * @returns one entry per `git <subcommand>`, in order.
 */
export function gitInvocations(command: string): GitInvocation[] {
  const found: GitInvocation[] = []
  for (const { program, args: words } of programInvocations(command)) {
    if (program !== 'git' && program !== 'git.exe') continue
    let index = 0
    while (index < words.length) {
      const token = words[index] ?? ''
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
    const subcommand = words[index]
    if (subcommand === undefined) continue
    found.push({ subcommand, args: words.slice(index + 1) })
  }
  return found
}

/**
 * Read the `command` string of a tool call, when it has one.
 *
 * Every shell-executing tool spells it `command`; anything else is left alone.
 * @param args - the raw, unvalidated arguments of the tool call.
 * @returns the command line, or `undefined` for a call that runs none.
 */
export function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value: unknown = (args as { command?: unknown }).command
  return typeof value === 'string' ? value : undefined
}
