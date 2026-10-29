// Reading shell command lines without running a shell.
//
// Every automatic check needs this: the pre-commit trigger asks "does this line
// create a commit?", the release trigger asks "does this line tag or publish?",
// and the git guard asks "does this line destroy work?". They must agree on
// where one command ends and the next begins, so the lexing lives here rather
// than in any of them.

/**
 * Tokens that end one command and begin another.
 *
 * A lone `&` belongs here: `cmd & rm -rf /` runs two commands, and without it
 * the second one was read as an argument of the first, so every guard behind
 * this lexer saw only the harmless half.
 */
const OPERATORS = new Set(['&&', '||', '&', ';', '|', '\n'])

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
  // Resource-limited runners. `timeout 120 git push --force` is an ordinary way
  // to write a push with a deadline, and leaving these out of the set made the
  // wrapper word itself the program, so every guard read `timeout` and found
  // nothing to judge.
  'timeout',
  'nice',
  'stdbuf',
  'ionice',
  'watch',
])

/**
 * Shells whose `-c` argument is a command line. `sh -c "git push --force"` and
 * `bash -c 'rm -rf /'` hide the real command inside one word, so the text after
 * `-c` is read again as a command line. This is a declared boundary in
 * SECURITY.md: a shell can always hide what it runs, and this only recovers the
 * ordinary spellings.
 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])

/**
 * Programs that are not shells but still take a command line in `-c`.
 *
 * `npx -c 'rm -rf /'` runs what it is given, exactly as a shell does. Leaving
 * `-c` in the wrapper's value options made the wrapper swallow its own script
 * and report no program at all, which is the same as no guard.
 */
const COMMAND_RUNNERS = new Set(['npx'])

/** A leading `VAR=value` assignment, as in `FOO=1 rm -rf /`. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The base name of a program word: `/usr/bin/git` becomes `git`. */
export function baseName(word: string): string {
  return word.replace(/\\/g, '/').split('/').pop() ?? word
}

/**
 * Wrapper options that take a separate value: `sudo -u root rm -rf /` really
 * starts at `rm`, and the value would otherwise be read as the program.
 *
 * Per wrapper, not one shared set: the letters collide. `sudo -p 'Password:'`
 * takes a value while `time -p` is a boolean flag, so one global table skipped
 * the program after `time -p`. A wrapper with no entry has no value options.
 */
const WRAPPER_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
  [
    'sudo',
    new Set([
      '--user',
      '--group',
      '--host',
      '--prompt',
      '--role',
      '--type',
      '--chdir',
      '--close-from',
      '--other-user',
      '-u',
      '-g',
      '-h',
      '-p',
      '-r',
      '-t',
      '-U',
    ]),
  ],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['exec', new Set(['-a'])],
  // `-c`/`--call` are deliberately absent: their value is a command line, and
  // treating it as an option value swallowed the command (`npx -c 'rm -rf /'`
  // parsed to nothing). `shellArgument` reads them instead.
  ['npx', new Set(['-p', '--package', '--npm', '--registry'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['ionice', new Set(['-c', '-n', '-p', '--class', '--classdata', '--pid'])],
  ['watch', new Set(['-n', '--interval', '-q', '--equexit'])],
])

/**
 * Leading positional arguments a wrapper names before the command it runs.
 * `timeout 120 git push` names a deadline first; without this the deadline was
 * read as the program and the push behind it went unjudged. `flock` is left out
 * of {@link TRANSPARENT} deliberately: its `-c` form hides the command inside an
 * option value, which this walk has no way to return, so peeling it would trade
 * one blind spot for another.
 */
const WRAPPER_POSITIONALS = new Map<string, number>([['timeout', 1]])

/**
 * The word that asks a shell for a command string: `-c`, or the same letter
 * inside a cluster such as `-lc` or `-ec`.
 */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/

/**
 * The argument of a shell's `-c`, when the words are one.
 * @param words - one command's words, wrapper included.
 * @returns the command line after `-c`, or `undefined` when there is none.
 */
export function shellArgument(words: readonly string[]): string | undefined {
  // The first word decides, and it must be the program: only a shell — or a
  // runner that behaves like one — has a command string behind `-c`. Reading
  // `-c` on any program turned `git -c core.pager=cat log` into a "script"
  // nobody asked for, so callers pass the program with its arguments.
  const name = baseName(words[0] ?? '')
  if (!SHELLS.has(name) && !COMMAND_RUNNERS.has(name)) return undefined
  const start = 1
  const flag = words[start] ?? ''
  // `npx --call '<cmd>'` and `npx --call=<cmd>` spell the same thing.
  if (flag === '--call' || flag.startsWith('--call=')) {
    const script = flag === '--call' ? words[start + 1] : flag.slice('--call='.length)
    return script === undefined || script === '' ? undefined : script
  }
  // `sh -lc 'rm -rf /'` is the login-shell spelling of the same thing and it is
  // how a script is run in CI: only the bare word `-c` used to be recognised, so
  // everything after it went unread. The command string is the next word
  // whichever letters share the flag, because a shell reads it from its first
  // non-option argument rather than from the rest of the option word.
  if (!SHELL_COMMAND_FLAG.test(flag)) return undefined
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
    const wrapper = baseName(word)
    const rest = words.slice(index + 1)
    // A runner whose `-c` hides a command line is not peeled: the script is an
    // option value, so peeling the wrapper would leave the script to be read as
    // the program itself. `shellArgument` reads it instead.
    if (
      COMMAND_RUNNERS.has(wrapper) &&
      rest.some((one) => one === '-c' || one === '--call' || one.startsWith('--call='))
    ) {
      break
    }
    while (rest[0] !== undefined && (ASSIGNMENT.test(rest[0]) || rest[0] === '--')) rest.shift()
    const values = WRAPPER_VALUE_OPTIONS.get(wrapper)
    // Every option the wrapper takes is stepped over, not just the first: a
    // wrapper accepts several, and stopping at one left the second option to be
    // read as the program — `sudo -n -u root rm` came out as a program named
    // `-u`.
    while (rest[0] !== undefined && rest[0].startsWith('-')) {
      const option = rest[0]
      rest.shift()
      // `--opt=value` carries its value in the same word.
      if (option.includes('=')) continue
      if (values?.has(option) === true) rest.shift()
    }
    // Positional arguments the wrapper names first: `timeout 120 cmd` puts the
    // deadline between the wrapper and the program.
    const positional = WRAPPER_POSITIONALS.get(wrapper) ?? 0
    for (let step = 0; step < positional; step += 1) {
      if (rest[0] === undefined || rest[0].startsWith('-')) break
      rest.shift()
    }
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
  let dropWord = false

  const flush = (): void => {
    if (!started) return
    // A write redirect names a file the command writes; it is not one of its
    // arguments, and keeping it in the stream made `2>/dev/null git push` read
    // as a command whose program was `null`. A read redirect (`< file`) is
    // kept, because the file it opens is exactly what the file guard looks for.
    if (dropWord) {
      current = ''
      started = false
      dropWord = false
      return
    }
    tokens.push(current)
    current = ''
    started = false
  }

  // `2>` and `0<` prefix the operator with the descriptor it applies to, and
  // that digit is not a word: a shell reads `cmd 2>/dev/null` as one command.
  const descriptorOnly = (): boolean => started && /^[0-9]+$/.test(current)

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
    // `cmd &> log` redirects both streams; it is not the `&` that backgrounds
    // a command, and splitting on it would read the redirect target as a
    // program of its own.
    if (char === '&' && next === '>') {
      flush()
      dropWord = true
      index += 1
      continue
    }
    if (char === '|' && next === '|') {
      flush()
      tokens.push('||')
      index += 1
      continue
    }
    if (char === '|' || char === ';' || char === '&') {
      flush()
      tokens.push(char)
      continue
    }
    // A redirection ends the word the way a space does. `cat<.env` used to stay
    // one word that matched no program name, so the file it opens was never a
    // candidate: no spaces around `<` was a way to read any sensitive file. The
    // operator itself is dropped rather than kept, because nothing downstream
    // reads it — the path after it is the part that matters.
    if (char === '<' || char === '>') {
      // `2>` names the descriptor; the `2` is not a word of its own. Flushing it
      // left `2>&1 cat .env` reading as a command whose program was `2`, so the
      // cat behind the redirect was never a candidate.
      if (!descriptorOnly()) flush()
      else {
        current = ''
        started = false
      }
      // `2>&1` and `>>&` carry a descriptor or an ampersand with them; stepping
      // over the pair keeps the descriptor from being read as an argument and
      // the `&` from being read as a separator.
      if (next === '&') {
        let scan = index + 2
        while (scan < command.length && /[0-9-]/.test(command.charAt(scan))) scan += 1
        index = scan - 1
      } else {
        if (next === '>') index += 1
        // Only a write redirect loses its target: `2>/dev/null git push` names no
        // file a reader would open, while `cat < .env` names exactly one.
        dropWord = char === '>'
      }
      continue
    }
    // `echo $(git push --force)` runs what is inside the substitution, so it is
    // read as a command of its own — at the cost of also reading text that only
    // interpolates. Unbalanced text stays a word, as it would in a shell.
    //
    // The boundary goes *before* the spliced words as well as after them: the
    // substitution is a command in its own right, so `cat $(rm -rf /)` must not
    // read as one command whose program is `cat` and whose arguments look
    // harmless. Only the closing `;` used to be pushed, which left the inner
    // words attached to whatever command preceded them.
    if ((char === '$' && next === '(') || char === '`') {
      const substituted = commandSubstitution(command, index)
      if (depth < MAX_SUBSTITUTION_DEPTH && !substituted.text.includes('\n')) {
        flush()
        tokens.push(';')
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
  let dropWord = false

  const flush = (): void => {
    if (started && !dropWord) words.push({ value, literal: !opaque })
    value = ''
    started = false
    opaque = false
    dropWord = false
  }

  // Same rule as in {@link tokenize}: the digits before a redirect are its
  // descriptor, not an argument and not the program.
  const descriptorOnly = (): boolean => started && /^[0-9]+$/.test(value)

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
    // Outside quotes a backslash escapes only the characters a shell gives it a
    // meaning to, exactly as {@link tokenize} reads it. Swallowing every
    // backslash turned `C:\Users\x\.env` into `C:Usersx.env` here while the
    // guards read the path intact — one command line, two answers.
    if (char === '\\' && index + 1 < command.length) {
      if (ESCAPABLE.has(next)) {
        value += next
        index += 1
      } else {
        value += char
      }
      started = true
      continue
    }
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      flush()
      continue
    }
    // `cmd &> log` redirects both streams; it is not the `&` that backgrounds a
    // command, and splitting on it would read the redirect target as a word of
    // its own.
    if (char === '&' && next === '>') {
      flush()
      dropWord = true
      index += 1
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
    if (char === '|' || char === ';' || char === '&') {
      flush()
      words.push({ value: char, literal: true })
      continue
    }
    // A redirection separates the same way it does in {@link tokenize}. The
    // operator is dropped: a caller wants the words around it, and the file a
    // redirection names is a path whichever of `<`, `>` or `>>` introduced it.
    if (char === '<' || char === '>') {
      // A bare descriptor belongs to the redirection, exactly as in
      // {@link tokenize}: `2>&1 cat .env` names `cat`, not `2`.
      if (!descriptorOnly()) flush()
      else {
        value = ''
        started = false
        opaque = false
      }
      if (next === '&') {
        let scan = index + 2
        while (scan < command.length && /[0-9-]/.test(command.charAt(scan))) scan += 1
        index = scan - 1
      } else {
        if (next === '>') index += 1
        // Same split as {@link tokenize}: a write redirect names no word of the
        // command, while a read redirect names the file that is the point of it.
        dropWord = char === '>'
      }
      continue
    }
    if ((char === '$' && next === '(') || char === '`') {
      // The substitution's own value is not this word's value: keep it as
      // written for the callers that only look at text, and mark the word as
      // one the shell resolves.
      opaque = true
      const substituted = commandSubstitution(command, index)
      if (depth < MAX_SUBSTITUTION_DEPTH && !substituted.text.includes('\n')) {
        // The text already read belongs to the same shell word: `git tag
        // v$(cat VERSION)` names one tag whose first half is knowable and whose
        // second half is not. Keeping the two halves together is what lets the
        // caller say "a name was given but cannot be read", which is a warning,
        // instead of judging the fragment `v` as the whole name.
        words.push({
          value: `${value}${command.slice(index, substituted.end)}`,
          literal: false,
        })
        // Same boundary {@link tokenize} keeps: the substitution runs as a
        // command of its own, so its words are not arguments of the command in
        // front of it.
        words.push({ value: ';', literal: true })
        words.push(...quoteCommandWords(substituted.text, depth + 1))
        words.push({ value: ';', literal: true })
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
    // The program is handed over with its arguments: `shellArgument` only
    // reads `-c` off a real shell (or `npx`), never off whatever program
    // happens to be there.
    const script = shellArgument([program, ...rest])
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
      const script = shellArgument([
        program.value,
        ...current.slice(index + 1).map((word) => word.value),
      ])
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
