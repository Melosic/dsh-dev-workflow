import type { Config } from '../config.js'
import { commandOf, segments, tokenize } from '../shell.js'
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
 */
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ['file_path'],
  read_image: ['file_path'],
  edit: ['file_path'],
  write: ['file_path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path', 'include'],
}

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
])

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
  const value = path.replace(/\\/g, '/').toLowerCase()
  const glob = pattern.replace(/\\/g, '/').toLowerCase()
  const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

  // A directory rule: the path is that directory or lives under it.
  if (glob.endsWith('/')) {
    const directory = glob.slice(0, -1)
    const expression = new RegExp(`(^|/)${escape(directory).replace(/\*/g, '[^/]*')}(/|$)`)
    return expression.test(value)
  }

  const expression = new RegExp(`(^|/)${escape(glob).replace(/\*/g, '[^/]*')}$`)
  if (expression.test(value)) return true

  // A pattern that names a path also matches at any depth: the caller may have
  // written the absolute form of the same file.
  if (glob.includes('/')) {
    return new RegExp(`${escape(glob).replace(/\*/g, '[^/]*')}$`).test(value)
  }

  const base = value.split('/').pop() ?? value
  if (new RegExp(`^${escape(glob).replace(/\*/g, '[^/]*')}$`).test(base)) return true

  // `.env` also covers `.env.local` and `.env.production`: the secret is in the
  // variants as much as in the file itself. A documented sample is the one
  // exception, because `.env.example` exists to be read — refusing it teaches
  // the reader nothing and only gets the rule switched off.
  if (!glob.startsWith('.') || glob.includes('*')) return false
  if (!base.startsWith(`${glob}.`)) return false
  return !SAMPLE_VARIANTS.has(base.slice(glob.length + 1))
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
  const fields = PATH_FIELDS[name]
  if (fields === undefined) return []
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  return fields
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string')
}

/**
 * Paths a shell command reads, from its words.
 *
 * Only the words of a known reader are considered, so a command that merely
 * mentions the name of a sensitive file in an unrelated argument is not a hit.
 * @param command - the command line.
 * @returns the candidate paths.
 */
function commandPaths(command: string): string[] {
  const found: string[] = []
  for (const segment of segments(tokenize(command))) {
    const program = segment[0]
    if (program === undefined) continue
    if (!READERS.has((program.split(/[\\/]/).pop() ?? program).toLowerCase())) continue
    found.push(...segment.slice(1).filter((word) => !word.startsWith('-')))
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
