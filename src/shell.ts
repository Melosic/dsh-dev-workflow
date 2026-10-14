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

/**
 * Shells whose `-c` argument is a command line. `sh -c "git push --force"` and
 * `bash -c 'rm -rf /'` hide the real command inside one word, so the text after
 * `-c` is read again as a command line. This is a declared boundary in
 * SECURITY.md: a shell can always hide what it runs, and this only recovers the
 * ordinary spellings.
 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])

/** A leading `VAR=value` assignment, as in `FOO=1 rm -rf /`. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The base name of a program word: `/usr/bin/git` becomes `git`. */
export function baseName(word: string): string {
  return word.replace(/\\/g, '/').split('/').pop() ?? word
}

/**
 * Wrapper options that take a separate value: `sudo -u root rm -rf /` really
 * starts at `rm`, and the value would otherwise be read as the program.
 */
const WRAPPER_VALUE_OPTIONS = new Set([
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--chdir',
  '-u',
  '-g',
  '-h',
  '-p',
  '-r',
  '-t',
])

/**
 * The argument of a shell's `-c`, when the words are one.
 * @param words - one command's words, wrapper included.
 * @returns the command line after `-c`, or `undefined` when there is none.
 */
export function shellArgument(words: readonly string[]): string | undefined {
  const start = words.length > 0 && SHELLS.has(baseName(words[0] ?? '')) ? 1 : 0
  if (words[start] !== '-c') return undefined
  const script = words[start + 1]
  return script === undefined || script === '' ? undefined : script
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
    // A shell is deliberately NOT peeled here. `programInvocations` has to see
    // `sh` to recover the script after `-c`; a walk that skips the shell and its
    // flag hands its callers the *script* as if it were the program, which is
    // how `sh -c "git push --force"` read as a program named
    // `git push --force`. Callers that want the delegated command call
    // `shellArgument` on the words after the program.
    if (ASSIGNMENT.test(word) || word === '--') {
      index += 1
      continue
    }
    // A wrapper takes its own options with it: `sudo -u root rm` puts a value
    // after an option, and reading `root` as the program would hide the `rm`.
    // The option and its value both step aside — shifting only the option leaves
    // the value to be read as the program, which is how `sudo -u root git push`
    // came out as a program named `root`.
    // Every wrapper that follows is looked at again, so `nohup doas rm` lands on
    // `rm` rather than stopping at `doas`.
    if (!TRANSPARENT.has(baseName(word))) break
    const rest = words.slice(index + 1)
    while (rest[0] !== undefined && (ASSIGNMENT.test(rest[0]) || rest[0] === '--')) rest.shift()
    const option = rest[0]
    if (option !== undefined && WRAPPER_VALUE_OPTIONS.has(option)) {
      rest.shift()
      rest.shift()
    } else if (option?.startsWith('--') && option.includes('=')) rest.shift()
    else if (option?.startsWith('-') && option.length > 2 && !option.startsWith('--')) rest.shift()
    index = words.length - rest.length
  }
  return index
}

/**
 * One command's words, starting at the program that does the work.
 *
 * The shared entry point for a caller that needs the program and its arguments
 * rather than a word list: `sudo cat .env` and `cat .env` have to read the same
 * way to a guard that matches on paths, or the wrapper is a way around it.
 * @param words - one segment's words.
 * @returns the program word followed by its arguments.
 */
export function programWords(words: readonly string[]): readonly string[] {
  return words.slice(skipWrappers(words))
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
 * Characters a backslash escapes outside quotes. A backslash before anything
 * else is a literal backslash, which is what keeps a Windows path such as
 * `C:\Users\me\.env` in one piece on the platform where it was written.
 */
const ESCAPABLE = new Set([
  ' ',
  '\t',
  '\r',
  '\n',
  '"',
  "'",
  '\\',
  '&',
  '|',
  ';',
  '(',
  ')',
  '{',
  '}',
  '$',
  '`',
])

/** How deep `$(...)` inside `$(...)` is still worth reading. */
const MAX_SUBSTITUTION_DEPTH = 8

/**
 * Read the text of a command substitution that starts at `$(`, or of a
 * backquoted one, so the command inside it is read as a command. An unbalanced
 * one runs to the end of the line, and one this cannot read is skipped.
 * @param command - the whole command line.
 * @param open - index of the opening `$(` or backtick.
 * @returns the inner command line and the index to continue at.
 */
function commandSubstitution(
  command: string,
  open: number,
): { readonly text: string; readonly end: number } {
  const backquote = command.charAt(open) === '`'
  const start = backquote ? open + 1 : open + 2
  let depth = 1
  let quote: '"' | "'" | null = null
  for (let index = start; index < command.length; index += 1) {
    const char = command.charAt(index)
    if (char === '\\' && !backquote) {
      index += 1
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      // A subshell may hold its own quotes, but one inside a word does not
      // change where this substitution ends.
      quote = char
      continue
    }
    if (backquote && char === '`') return { text: command.slice(start, index), end: index + 1 }
    if (!backquote && char === '(') depth += 1
    if (!backquote && char === ')' && (depth -= 1) === 0) {
      return { text: command.slice(start, index), end: index + 1 }
    }
  }
  return { text: command.slice(start), end: command.length }
}

/**
 * Split a shell command into words, resolving quotes and escaping. Separators
 * survive as their own token so command boundaries can be recovered.
 * @param command - the command line.
 * @param depth - how many substitutions deep this call already is.
 * @returns the tokens, in order.
 */
export function tokenize(command: string, depth = 0): string[] {
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
      // A single-quoted shell string takes backslashes literally. Inside a
      // double quoted one a backslash escapes the next character only when the
      // shell gives that character a meaning: `"C:\Users\x"` is the path it looks
      // like, not `C:Usersx`, because a shell leaves `\U` alone.
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        if (ESCAPABLE.has(next)) {
          current += next
          index += 1
        } else {
          current += char
        }
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
      if (ESCAPABLE.has(next)) {
        current += next
        index += 1
      } else {
        current += char
      }
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
    // `echo $(git push --force)` runs what is inside the substitution, so it is
    // read as a command of its own — at the cost of also reading text that only
    // interpolates. Unbalanced text stays a word, as it would in a shell.
    if ((char === '$' && next === '(') || char === '`') {
      const substituted = commandSubstitution(command, index)
      if (depth < MAX_SUBSTITUTION_DEPTH && !substituted.text.includes('\n')) {
        flush()
        tokens.push(...tokenize(substituted.text, depth + 1))
        tokens.push(';')
        index = substituted.end - 1
        continue
      }
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
 * One word of a command line, with what the shell does to it.
 *
 * The checks need this and the guards do not: a guard acts on a program name, so
 * the resolved word is all it can use, while a check has to know whether the text
 * it is about to read is text git will record. `$(cat message.txt)` reaching this
 * as `cat` is exactly the case it must not confuse with a message.
 */
export interface CommandWord {
  /** The word after quotes and escapes are resolved. */
  readonly value: string
  /**
   * Whether the text of the word is the text the shell really uses.
   *
   * A single-quoted run, a double-quoted run without expansions, and an escaped
   * character all keep their text; a command substitution, a backtick and a
   * parameter expansion do not, whether they were quoted or not. `'$(cat x)'`
   * is literal, `"$(cat x)"` is not.
   */
  readonly literal: boolean
}

/**
 * Read a command line as words that say how they were written.
 *
 * A word is made of one or more adjacent quoted or unquoted runs, and it is
 * literal unless the shell would resolve part of it: a single quote, a double
 * quote, and a backslash all keep their text, while `$(...)`, a backtick and a
 * parameter expansion do not. A substitution whose own command can be read is
 * spliced into the stream as well, because that inner command is what runs.
 * @param command - a shell command line, as a tool would receive it.
 * @param depth - how many substitutions deep this call already is.
 * @returns the words of every command in it, in order.
 */
export function quoteCommandWords(command: string, depth = 0): CommandWord[] {
  const words: CommandWord[] = []
  let value = ''
  let started = false
  let opaque = false
  let expansion = false

  const flush = (): void => {
    if (started) words.push({ value, literal: !opaque })
    value = ''
    started = false
    opaque = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    const next = command.charAt(index + 1)
    if (char === "'") {
      let scan = index + 1
      while (scan < command.length && command.charAt(scan) !== "'") scan += 1
      value += command.slice(index + 1, scan)
      started = true
      index = scan
      continue
    }
    if (char === '"') {
      let scan = index + 1
      const from = scan
      while (scan < command.length && command.charAt(scan) !== '"') {
        if (command.charAt(scan) === '\\' && scan + 1 < command.length) scan += 1
        scan += 1
      }
      const inner = command.slice(from, scan)
      // Inside double quotes the shell still resolves `$`, a backtick and a
      // backslash; everything else is text, so `"Adds a flag."` is readable
      // while `"$(cat pr.md)"` is not.
      if (/(^|[^\\])[$`]/.test(inner)) opaque = true
      value += inner.replace(/\\([\\"$`])/g, '$1')
      started = true
      index = scan
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      value += next
      started = true
      index += 1
      continue
    }
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      flush()
      continue
    }
    if (char === '&' && next === '&') {
      flush()
      words.push({ value: '&&', literal: true })
      index += 1
      continue
    }
    if (char === '|' && next === '|') {
      flush()
      words.push({ value: '||', literal: true })
      index += 1
      continue
    }
    if (char === '|' || char === ';') {
      flush()
      words.push({ value: char, literal: true })
      continue
    }
    if ((char === '$' && next === '(') || char === '`') {
      // The substitution's own value is not this word's value: keep it as
      // written for the callers that only look at text, and mark the word as
      // one the shell resolves.
      opaque = true
      const substituted = commandSubstitution(command, index)
      if (depth < MAX_SUBSTITUTION_DEPTH && !substituted.text.includes('\n')) {
        words.push({ value: command.slice(index, substituted.end), literal: false })
        words.push(...quoteCommandWords(substituted.text, depth + 1))
        value = ''
        started = false
        opaque = false
        index = substituted.end - 1
        continue
      }
    }
    if (char === '{' && value.endsWith('$')) {
      expansion = true
      opaque = true
      value += char
      started = true
      continue
    }
    if (char === '}' && expansion) {
      expansion = false
      value += char
      started = true
      continue
    }
    if (char === '(' || char === ')' || char === '{' || char === '}') {
      flush()
      continue
    }
    if (char === '$') opaque = true
    value += char
    started = true
  }
  flush()
  return words
}

/**
 * Whether the text of a word is something a check can judge.
 *
 * The lexer records this: a word the shell resolves — a substitution, a
 * backtick, a parameter expansion — has no text a check can read, while
 * `'$(cat message.txt)'` and `"a plain body"` both do. A calling check has to
 * treat the first case as "a message was named but cannot be read", never as
 * "no message was named".
 * @param word - one word, as {@link quoteCommandWords} produced it.
 * @returns whether the word is literal text.
 */
export function shellWordIsLiteral(word: CommandWord): boolean {
  return word.literal
}

const TOKEN_CACHE_LIMIT = 64
const tokenCache = new Map<string, string[]>()
/**
 * {@link tokenize}, cached: one command line is read by three triggers and five
 * guards in the same turn, and tokenizing is a pure function of the text.
 * @param command - the command line.
 * @returns the tokens, in order.
 */
function tokenizeCached(command: string): readonly string[] {
  const cached = tokenCache.get(command)
  if (cached !== undefined) return cached
  const tokens = tokenize(command)
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear()
  tokenCache.set(command, tokens)
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
 * a value. For a command its own guards already decided to block, the words
 * this cannot read are noted in SECURITY.md.
 * @param command - a shell command line, as a tool would receive it.
 * @returns one entry per command, in order.
 */
export function programInvocations(command: string): ProgramInvocation[] {
  const found: ProgramInvocation[] = []
  for (const words of segments(tokenizeCached(command))) {
    const index = skipWrappers(words)
    const program = words[index]
    if (program === undefined) continue
    // `skipWrappers` treats a shell with a `-c` script as a wrapper, so by here
    // `sh -c "…"` has already become the words `-c`, `…` — one flag to step over.
    // `shellArgument` still accepts the unpeeled `sh -c …` spelling.
    const rest = words.slice(index + 1)
    const script =
      shellArgument(rest) ??
      (SHELLS.has(baseName(program)) && rest[0] === '-c' ? rest[1] : undefined)
    if (script !== undefined) {
      found.push(...programInvocations(script))
      continue
    }
    found.push({ program: baseName(program), args: rest })
  }
  return found
}

/**
 * One program found in a command line, with its words still saying how they were
 * written. {@link programInvocations} throws that away because a guard only needs
 * the program name; a check needs it kept.
 */
export interface ProgramWordInvocation {
  /** The program's base name, e.g. `git` for `/usr/bin/git`. */
  readonly program: string
  /** Every word after it, options included. */
  readonly args: readonly CommandWord[]
}

/**
 * Find each program in a word list, as {@link programInvocations} does for a
 * command line, keeping each word's provenance.
 * @param words - the words of a command line.
 * @param depth - how many substitutions deep this call already is.
 * @returns one entry per command, in order.
 */
export function wordInvocations(words: readonly CommandWord[], depth = 0): ProgramWordInvocation[] {
  const found: ProgramWordInvocation[] = []
  let current: CommandWord[] = []
  const commit = (): void => {
    const index = skipWrappers(current.map((word) => word.value))
    const program = current[index]
    if (program !== undefined) {
      // The script is what follows the program, not the program itself:
      // `shellArgument` also accepts `-c script` on its own (a bare `sh` word
      // already peeled by the wrapper walk), so it is handed the arguments.
      const script = shellArgument(current.slice(index + 1).map((word) => word.value))
      if (script === undefined || depth >= MAX_SUBSTITUTION_DEPTH) {
        // A wrapper whose script cannot be read is still a program: it is the
        // command line's outermost word, and saying so is all this can do.
        found.push({ program: baseName(program.value), args: current.slice(index + 1) })
      } else {
        found.push(...wordInvocations(quoteCommandWords(script, depth + 1), depth + 1))
      }
    }
    current = []
  }
  for (const word of words) {
    if (OPERATORS.has(word.value)) {
      commit()
      continue
    }
    current.push(word)
  }
  commit()
  return found
}

/**
 * Read the subcommand of a `git` word list, as `gitInvocations` does — the same
 * skip over global options, so `git --no-pager commit -m x` is a commit.
 * @param args - the words after `git`.
 * @returns the subcommand and the words after it.
 */
export function subcommandWords(
  args: readonly CommandWord[],
): { readonly subcommand: string; readonly args: readonly CommandWord[] } | undefined {
  let index = 0
  while (index < args.length) {
    const token = args[index]?.value ?? ''
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
  const subcommand = args[index]?.value
  if (subcommand === undefined) return undefined
  return { subcommand, args: args.slice(index + 1) }
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
