import type { Config } from '../config.js'
import { baseName, commandOf, programWords, segments, shellArgument, tokenize } from '../shell.js'
import { createGuard } from './shared.js'
import type { GuardAction, GuardHit, GuardOptions } from './shared.js'

// The file guard keeps the plugin's own rule — "sensitive files must not be
// read" — from being advice. It has no pre-read hook to stand on: DSH emits
// `fs/write-intent` and `fs/edit-intent` for mutations but nothing for reads,
// and `ToolCallKind` is presentation metadata that is not filled in yet when a
// call is gated. What it does have is the same gate the other guards use, plus
// the call's own arguments, so it reads the path out of the arguments and
// compares it against `fileGuard.noRead`.
//
// Match, never open. The guard decides from the path string alone; it does not
// stat the target, so a pattern that is not there costs nothing and a symlink
// cannot be used to talk it out of the way. The default policy is `deny` rather
// than `ask`, because the approval prompt would have to display the very path
// the rule exists to keep out of a transcript.

/** Options the file guard needs; the shared ones, unchanged. */
export type FileGuardOptions = GuardOptions

/** The one policy this guard applies: a sensitive path is never opened. */
const ACTION: GuardAction = 'deny'

/** Dictionary key naming the refusal. */
const BLOCKED = 'security.sensitive_file_blocked'

/**
 * Suffixes of a dotfile that name a sample rather than the real thing.
 * `.env.example` and `.env.sample` document the variables; they carry no
 * secret, and blocking them only encourages the guard to be turned off.
 */
const SAMPLE_VARIANTS = new Set(['example', 'sample', 'template', 'dist', 'defaults'])

/**
 * Argument fields that name a path, per tool. Keyed by tool name so that an
 * ordinary string argument — a commit message that happens to mention `.env` —
 * is never mistaken for a path.
 *
 * `grep.pattern` is deliberately absent: it is a search expression, not a path,
 * and matching it against `noRead` would refuse `grep -rn "credentials" .` —
 * exactly the check that tells you whether a secret is in the tree. The files a
 * search reads are named by `path` and `include`.
 */
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ['file_path'],
  read_image: ['file_path'],
  edit: ['file_path'],
  write: ['file_path'],
  glob: ['pattern', 'path'],
  grep: ['path', 'include'],
  // The same argument names under the host's file tools. A tool this table
  // does not name used to contribute no paths at all, so every spelling it was
  // missing passed silently - the guard said nothing rather than saying it did
  // not know the tool.
  read_file: ['path', 'file_path'],
  read_files: ['path', 'file_path', 'paths', 'files'],
  write_file: ['path', 'file_path'],
  edit_file: ['path', 'file_path'],
  apply_patch: ['path', 'file_path'],
}

/** Argument fields that name a path, across the host's own tool spellings. */
const FIELD_NAMES = new Set(['path', 'paths', 'file', 'files', 'file_path', 'file_paths'])

/** Programs whose job is to print a file, so their path arguments are reads. */
const READERS = new Set([
  'cat',
  'bat',
  'tac',
  'less',
  'more',
  'head',
  'tail',
  'type',
  'strings',
  'nl',
  'sed',
  'awk',
  'grep',
  'rg',
  'findstr',
  'get-content',
  'gc',
  'select-string',
  // Copying and archiving read the file just as printing it does: `cp .env
  // /tmp/x` publishes the secret to a place the guard then cannot see, and
  // `tar cf out.tar .env` puts it in a blob no later check will read.
  'cp',
  'mv',
  'install',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  'scp',
  'rsync',
  'dd',
  'base64',
  'xxd',
  'od',
  'tee',
  'sftp',
  'curl',
  'wget',
])

/** Programs that take a path as `if=<path>` / `of=<path>` rather than bare. */
const KEYED_PATH_PROGRAM = new Set(['dd'])

/** Programs that run another program over their input or arguments. */
const DELEGATING = new Set(['xargs'])

/** `xargs` options that take a separate value. */
const DELEGATING_VALUE_OPTIONS = new Set([
  '-I',
  '-L',
  '-n',
  '-P',
  '-s',
  '-a',
  '-d',
  '-E',
  '--arg-file',
  '--delimiter',
  '--max-args',
  '--max-lines',
  '--max-procs',
  '--max-chars',
  '--replace',
])

/**
 * Readers whose first non-option word is an expression rather than a path:
 * the search term of `grep`/`rg`/`findstr`, the script of `sed`/`awk`, the
 * `-Pattern` value of `Select-String`.
 *
 * Without this, `grep -rn "credentials" .` refuses itself — the guard reads the
 * search term as a file it is about to open, which blocks exactly the check
 * that tells you whether a secret is in the tree. The remaining words are
 * still read as paths, so `grep -rn "add .env" .env` is still refused.
 */
const EXPRESSION_FIRST = new Set(['sed', 'awk', 'grep', 'rg', 'findstr', 'select-string'])

/** Compiled pattern bodies, keyed by the pattern as written. */
const PATTERN_CACHE = new Map<string, readonly RegExp[]>()

/** How many distinct patterns the cache keeps before it is dropped. */
const PATTERN_CACHE_LIMIT = 256

/**
 * Fold a path or pattern for comparison.
 *
 * Only Windows is case-insensitive. Folding on every platform made `.ENV` a
 * secret on Linux, where it is an ordinary file with an ordinary name — the
 * guard answered a question nobody asked and taught the reader to turn it off.
 * @param text - a path or pattern.
 * @returns the text to compare.
 */
function fold(text: string): string {
  const normalised = text.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised
}

/**
 * The expressions one pattern is tested with: the whole path, and the final
 * component on its own.
 * @param glob - the pattern, already folded and slash-normalised.
 * @returns the regular expressions, in the order they are tried.
 */
function compilePattern(glob: string): readonly RegExp[] {
  const cached = PATTERN_CACHE.get(glob)
  if (cached !== undefined) return cached
  const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escape(glob).replace(/\*/g, '[^/]*')
  // A directory rule covers that directory and everything under it.
  const directory = glob.endsWith('/')
    ? new RegExp(`(^|/)${escape(glob.slice(0, -1)).replace(/\*/g, '[^/]*')}(/|$)`)
    : undefined
  // `(^|/)` on both ends keeps a pattern with a slash inside a path component:
  // `config/secrets` covers `app/config/secrets` and not `myconfig/secrets`.
  const compiled = [directory, new RegExp(`(^|/)${body}$`), new RegExp(`^${body}$`)].filter(
    (one): one is RegExp => one !== undefined,
  )
  if (PATTERN_CACHE.size >= PATTERN_CACHE_LIMIT) PATTERN_CACHE.clear()
  PATTERN_CACHE.set(glob, compiled)
  return compiled
}

/**
 * Whether one path is covered by one configured pattern.
 *
 * A trailing `/` matches a directory and everything under it; a pattern with a
 * `/` in it matches at any depth, so `.ssh/id_rsa` also covers
 * `C:/Users/x/.ssh/id_rsa`; anything else matches the file name, where a leading
 * dot also covers the variants that dotfile may be split into (`.env` covers
 * `.env.local`). `*` matches any run of characters.
 * @param path - the path a call names, as written.
 * @param pattern - one entry of `fileGuard.noRead`.
 * @returns whether the path is protected.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const value = fold(path)
  const glob = fold(pattern)
  // The list is [directory?, wholePath, basename]: a directory rule is tested
  // against the whole path, the other two against the path and its last
  // component respectively.
  const [directory, whole, base] = compilePattern(glob)
  // A directory rule is decisive when it matches, but not when it does not:
  // `.env` still has its own variants to check below.
  if (directory !== undefined && directory.test(value)) return true
  if (whole !== undefined && whole.test(value)) return true
  const name = value.split('/').pop() ?? value
  if (base !== undefined && base.test(name)) return true

  // `.env` also covers `.env.local` and `.env.production`: the secret is in the
  // variants as much as in the file itself. A documented sample is the one
  // exception, because `.env.example` exists to be read — refusing it teaches
  // the reader nothing and only gets the rule switched off.
  if (!glob.startsWith('.') || glob.includes('*')) return false
  if (!name.startsWith(`${glob}.`)) return false
  return !SAMPLE_VARIANTS.has(name.slice(glob.length + 1))
}

/**
 * The first protected path among some candidates.
 * @param candidates - paths a call names, in argument order.
 * @param patterns - `fileGuard.noRead`.
 * @returns the matching path, or `undefined` when none is protected.
 */
function match(
  candidates: readonly string[],
  patterns: readonly string[],
): { path: string; pattern: string } | undefined {
  for (const candidate of candidates) {
    if (candidate === '') continue
    for (const pattern of patterns) {
      if (matchesPattern(candidate, pattern)) return { path: candidate, pattern }
    }
  }
  return undefined
}

/**
 * Path strings a call names, from the tool's own argument fields.
 * @param name - the tool being called.
 * @param args - its arguments.
 * @returns the candidate paths.
 */
function argumentPaths(name: string, args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  // The table names the fields of the tools this build ships, and is read first
  // because a tool may pass a path in a field that is not path-shaped
  // (`glob.pattern`). Everything else — a later built-in, an MCP tool, a name
  // this plugin has never heard of — is read by argument name instead: the
  // path-shaped fields are the same few spellings across the host's tools, and
  // keeping a list of blessed tool names is how the guard ends up protecting
  // only the tools it knows by heart. Prose fields are not in that set, so a
  // commit message that merely mentions .env stays harmless.
  const names = PATH_FIELDS[name] ?? Object.keys(record).filter((field) => FIELD_NAMES.has(field))
  if (names.length === 0) return []
  const found: string[] = []
  for (const field of names) {
    const value = record[field]
    // A field may hold one path or a batch: `read_files` takes `paths: [...]`,
    // and reading only the string-shaped fields let a batch call through with
    // no candidate at all.
    if (typeof value === 'string') found.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') found.push(entry)
    }
  }
  return found
}

/**
 * Paths a shell command reads, from its words.
 *
 * Only the words of a known reader are considered, so a command that merely
 * mentions the name of a sensitive file in an unrelated argument is not a hit.
 * For the readers whose first free word is an expression rather than a path
 * (`grep`, `rg`, `sed`, `awk`, `findstr`, `Select-String`), that word is
 * skipped: `grep -rn "credentials" .` is the search that shows whether a secret
 * is in the tree, and reading its pattern as a path refuses the check that
 * finds the problem. The dangerous spellings this gives up are the ones
 * SECURITY.md already lists.
 * @param command - the command line.
 * @returns the candidate paths.
 */
function commandPaths(command: string): string[] {
  const found: string[] = []
  for (const segment of segments(tokenize(command))) {
    const words = programWords(segment)
    // `sh -c 'cat .env'` reads the same file as `cat .env`. The script is a
    // command line in its own right, so it is read as one rather than as
    // arguments of `sh` — the same unwrapping the command guard does.
    const script = shellArgument(words)
    if (script !== undefined) {
      found.push(...commandPaths(script))
      continue
    }
    const program = words[0]
    if (program === undefined) continue
    const name = baseName(program).toLowerCase()
    // `xargs cat .env` reads the file just as `cat .env` does, but the program
    // doing it is the first *free* word, not the first one. Without this the
    // filter below finds no reader and the command looks harmless.
    if (DELEGATING.has(name)) {
      // `xargs` options come first and some of them take a value; the program
      // it runs starts at the first word that is neither.
      const rest = words.slice(1)
      let index = 0
      while (index < rest.length) {
        const word = rest[index] ?? ''
        if (!word.startsWith('-')) break
        index += 1
        if (!word.includes('=') && DELEGATING_VALUE_OPTIONS.has(word)) index += 1
      }
      const inner = rest.slice(index)
      if (inner.length > 0) found.push(...commandPaths(inner.join(' ')))
      continue
    }
    if (!READERS.has(name)) continue
    // `dd if=.env of=/tmp/x` names its paths with a key rather than as words, so
    // the `=` form is read here instead of being filtered out as an option.
    if (KEYED_PATH_PROGRAM.has(name)) {
      for (const word of words.slice(1)) {
        const match = /^(?:if|of|seek|skip)=(.+)$/.exec(word)
        if (match?.[1] !== undefined) found.push(match[1])
      }
      continue
    }
    const free = words.slice(1).filter((word) => !word.startsWith('-'))
    // `grep 'credentials' .` searches for a word; `grep .env .` reads a file.
    // The first free word is the expression, so it is dropped before the rest
    // is read as paths. It is dropped from the raw list, not from the filtered
    // one: an expression containing a space is not a path either way, and
    // shifting after that filter would eat the real one.
    if (EXPRESSION_FIRST.has(name)) free.shift()
    found.push(...free.filter((word) => /^\S+$/.test(word)))
  }
  return found
}

/**
 * Classify one call.
 * @param args - the call's arguments.
 * @param name - the tool being called.
 * @param config - resolved plugin configuration.
 * @returns the refusal, or `undefined` for an ordinary call.
 */
export function detectFile(args: unknown, name: string, config: Config): GuardHit | undefined {
  if (!config.fileGuard.enabled.get()) return undefined
  const patterns = config.fileGuard.noRead.get()
  if (patterns.length === 0) return undefined

  const command = commandOf(args)
  const candidates =
    command === undefined
      ? argumentPaths(name, args)
      : [...commandPaths(command), ...argumentPaths(name, args)]
  const found = match(candidates, patterns)
  if (found === undefined) return undefined

  // The file name is named, its contents never are, and the pattern that caught
  // it is shown so the rule can be recognised as intentional rather than as a
  // misfire.
  return { reason: BLOCKED, action: ACTION, params: { file: found.path, rule: found.pattern } }
}

/**
 * Build the `tools/pre-execute` listener for the file guard.
 * @param options - the shared guard options.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createFileGuard(options: FileGuardOptions): ReturnType<typeof createGuard> {
  return createGuard({
    ...options,
    label: 'file guard',
    detect: (exec) => detectFile(exec.arguments, exec.name, options.config()),
  })
}
