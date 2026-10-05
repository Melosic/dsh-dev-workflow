import type { Config } from '../config.js'
import { commandOf, segments, tokenize } from '../shell.js'
import { createGuard, hasShortOption, strictest } from './shared.js'
import type { GuardAction, GuardHit, GuardOptions } from './shared.js'

// The command guard recognises shell commands that can destroy a machine rather
// than a commit: a recursive forced delete aimed at a filesystem root, a
// filesystem being reformatted, raw writes to a block device, and the fork bomb.
// None of them can be undone by git, which is why they are a separate guard from
// the git one — and why its default is `ask` rather than `allow`.
//
// Recognition reads the command line only. It never resolves a path and never
// opens a file, so the guard needs no sandbox and cannot be talked into touching
// what it exists to protect. A command hidden inside another shell
// (`sh -c 'rm -rf /'`) is not unwrapped: the outer invocation names `sh`, which
// is not one of the patterns below.

/** Options the command guard needs; the shared ones, unchanged. */
export type CommandGuardOptions = GuardOptions

/** Dictionary key naming the operation shared by every pattern below. */
const DANGEROUS = 'command.guard.dangerous_warning'
/** Dictionary key appended when the configured policy refuses the call. */
const REFUSED = 'command.guard.denied'
/** Dictionary key appended when the configured policy asks about the call. */
const CONFIRM = 'command.guard.confirm_required'

/** Program names that only wrap the real command: `sudo rm -rf /` starts at `rm`. */
const TRANSPARENT = new Set(['sudo', 'doas', 'env', 'nohup', 'command', 'exec', 'time'])

/** A leading `VAR=value` assignment, as in `FOO=1 rm -rf /`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Targets where a recursive forced delete removes a filesystem, not a directory. */
const DANGEROUS_TARGETS = new Set([
  '/',
  '/*',
  '//',
  '~',
  '~/',
  '$HOME',
  '${HOME}',
  '.',
  '..',
  '*',
  './*',
  '../*',
  '/.',
  '/..',
])

/** A single component under root, e.g. `/etc`: a whole system directory. */
const SYSTEM_DIRECTORY = /^\/[A-Za-z0-9_.-]+\/?$/

/** The classic shell fork bomb, which is a syntax rather than an invocation. */
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*;?\s*\}\s*;?\s*:/

/** A redirect aimed at a block device. */
const DEVICE_REDIRECT =
  /(^|[^>])>\s*\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|nvme\d+n\d+|mmcblk\d+|disk\d+|loop\d+)/

/**
 * A `dd` operand naming a block device, on either side. `if=` matters as much as
 * `of=`: reading a raw disk is a privileged operation, and a question costs less
 * than a wrong guess. `dd if=image.iso of=out.img` is how images are made and
 * names no device, so it passes.
 */
const DD_DEVICE = /^(if|of)=\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|nvme\d+n\d+|mmcblk\d+|disk\d+|loop\d+)/

/**
 * The last path component of a word, so a full path and a bare name compare alike.
 * @param word - one command word.
 * @returns the base name.
 */
function basename(word: string): string {
  return word.replace(/\\/g, '/').split('/').pop() ?? word
}

/**
 * Drop the wrappers in front of the real program.
 * @param segment - one command's words.
 * @returns the words starting at the program that does the work.
 */
function commandWords(segment: readonly string[]): readonly string[] {
  let index = 0
  while (index < segment.length) {
    const word = segment[index]
    if (word === undefined) break
    if (TRANSPARENT.has(basename(word)) || ASSIGNMENT.test(word)) {
      index += 1
      continue
    }
    break
  }
  return segment.slice(index)
}

/**
 * Whether deleting this target is a destructive act rather than an ordinary one.
 * @param target - a non-option word from an `rm` command.
 * @returns whether the target is a filesystem root or a whole system directory.
 */
function isDangerousTarget(target: string): boolean {
  const value = target.replace(/\\/g, '/')
  if (DANGEROUS_TARGETS.has(value)) return true
  if (value.endsWith('/*') && DANGEROUS_TARGETS.has(value.slice(0, -1))) return true
  return SYSTEM_DIRECTORY.test(value)
}

/**
 * The target of a recursive forced delete, when there is one.
 * @param args - the words after `rm`.
 * @returns the first destructive target, or `undefined` for an ordinary delete.
 */
function destroyTarget(args: readonly string[]): string | undefined {
  const recursive = hasShortOption(args, 'rR') || args.includes('--recursive')
  const forced = hasShortOption(args, 'f') || args.includes('--force')
  if (!recursive || !forced) return undefined
  return args.find((arg) => !arg.startsWith('-') && isDangerousTarget(arg))
}

/**
 * Build the hit for one pattern.
 * @param pattern - the language-neutral idiom that was recognised.
 * @param action - the configured policy.
 * @returns the hit, before the tier decides its closing line.
 */
function hit(pattern: string, action: GuardAction): GuardHit {
  return { reason: DANGEROUS, action, params: { pattern } }
}

/**
 * Add the line that matches the tier the hit resolved to: a refusal reads
 * differently from a question, and the status tally keeps one stable key.
 * @param hit - the recognised operation.
 * @returns the hit with its closing line.
 */
function withTier(hit: GuardHit): GuardHit {
  return { ...hit, suggestion: hit.action === 'deny' ? REFUSED : CONFIRM }
}

/**
 * Every dangerous pattern one command segment performs.
 * @param segment - one command's words.
 * @param action - the configured policy.
 * @returns the hits, in the order the patterns are considered.
 */
function hitsFor(segment: readonly string[], action: GuardAction): GuardHit[] {
  const words = commandWords(segment)
  const program = words[0]
  if (program === undefined) return []
  const name = basename(program)
  const args = words.slice(1)
  const hits: GuardHit[] = []

  if (name === 'rm' && destroyTarget(args) !== undefined) hits.push(hit('rm -rf', action))

  // `mkfs`, `mkfs.ext4`, `mkfs.xfs`: one family, recognised by prefix.
  if (name === 'mkfs' || name.startsWith('mkfs.')) hits.push(hit('mkfs', action))

  if (name === 'dd' && args.some((arg) => DD_DEVICE.test(arg))) hits.push(hit('dd', action))

  if (name === 'chmod') {
    const recursive = hasShortOption(args, 'R') || args.includes('--recursive')
    const open = args.some(
      (arg) =>
        !arg.startsWith('-') && (/^[0-7]*777$/.test(arg) || arg === 'a+rwx' || arg === '+rwx'),
    )
    const target = args.find((arg) => !arg.startsWith('-') && isDangerousTarget(arg))
    if (recursive && open && target !== undefined) hits.push(hit('chmod -R 777', action))
  }

  return hits
}

/**
 * Classify one shell command.
 * @param command - the command line the agent is about to run.
 * @param config - resolved plugin configuration.
 * @returns the strictest recognised operation, or `undefined` for an ordinary command.
 */
export function detectCommand(command: string, config: Config): GuardHit | undefined {
  if (!config.commandGuard.enabled) return undefined
  const action = config.commandGuard.dangerousShell

  const hits: GuardHit[] = []
  // Both of these are syntax rather than an invocation, so they are tested
  // against the whole line rather than a segmented word list.
  if (FORK_BOMB.test(command)) hits.push(hit('fork bomb', action))
  if (DEVICE_REDIRECT.test(command)) hits.push(hit('raw device write', action))
  for (const segment of segments(tokenize(command))) hits.push(...hitsFor(segment, action))

  const best = strictest(hits)
  return best === undefined ? undefined : withTier(best)
}

/**
 * Build the `tools/pre-execute` listener for the command guard.
 * @param options - the shared guard options.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createCommandGuard(options: CommandGuardOptions): ReturnType<typeof createGuard> {
  return createGuard({
    ...options,
    label: 'command guard',
    detect: (exec) => {
      const command = commandOf(exec.arguments)
      return command === undefined ? undefined : detectCommand(command, options.config())
    },
  })
}
