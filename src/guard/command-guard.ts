import type { Config } from '../config.js'
import { baseName, commandOf, programWords, segments, shellArgument, tokenize } from '../shell.js'
import { createGuard, hasShortOption, strictest } from './shared.js'
import type { GuardAction, GuardHit, GuardOptions } from './shared.js'

// The command guard recognises shell commands that can destroy a machine rather
// than a commit: a recursive delete aimed at a filesystem root, a filesystem
// being reformatted, raw writes to a block device, and the fork bomb. None of
// them can be undone by git, which is why they are a separate guard from the git
// one — and why its default is `ask` rather than `allow`.
//
// Recognition reads the command line only. It never resolves a path and never
// opens a file, so the guard needs no sandbox and cannot be talked into touching
// what it exists to protect. A command hidden inside another shell
// (`sh -c 'rm -rf /'`) is unwrapped by the lexer, and one hidden in a way this
// cannot read is a declared boundary in SECURITY.md rather than a promise.

/** Options the command guard needs; the shared ones, unchanged. */
export type CommandGuardOptions = GuardOptions

/** Dictionary key naming the operation shared by every pattern below. */
const DANGEROUS = 'command.guard.dangerous_warning'
/** Dictionary key appended when the configured policy refuses the call. */
const REFUSED = 'command.guard.denied'
/** Dictionary key appended when the configured policy asks about the call. */
const CONFIRM = 'command.guard.confirm_required'

/**
 * Targets where a recursive forced delete removes a filesystem, not a directory.
 *
 * Written in lower case because {@link normalizeTarget} folds the word before
 * comparing: every entry here is a spelling a shell compares case-insensitively,
 * on one platform or the other.
 */
const DANGEROUS_TARGETS = new Set([
  '/',
  '/*',
  '//',
  '~',
  '$home',
  '${home}',
  '$env:userprofile',
  '%userprofile%',
  '%homepath%',
  '.',
  '..',
  '*',
  './*',
  '../*',
  '/.',
  '/..',
])

/**
 * The subset of {@link DANGEROUS_TARGETS} that names a filesystem or a home
 * directory rather than a place inside one.
 *
 * `rm -rf .` and `find . -name '*.log' -delete` are not the same act even though
 * both spell their target `.`: the first takes the whole tree, the second takes
 * what a predicate picked out. A filesystem root leaves no such room — no filter
 * makes deleting from `/` or `~` a scoped act.
 */
const ROOT_TARGETS = new Set([
  '/',
  '/*',
  '//',
  '~',
  '$home',
  '${home}',
  '$env:userprofile',
  '%userprofile%',
  '%homepath%',
  '/.',
  '/..',
])

/** A single component under root, e.g. `/etc` or `C:/Users`: a whole system directory. */
const SYSTEM_DIRECTORY = /^(\/|[a-z]:\/)[A-Za-z0-9_.-]+\/?$/i

/** A drive's root: `C:`, `C:/`, `C:\` all name the same place to a shell. */
const DRIVE_ROOT = /^[a-z]:$/i

/** A drive letter on its own, as `format` and `Format-Volume` take one. */
const DRIVE_LETTER = /^[a-z]:?$/i

/**
 * Programs whose job is to remove a tree, on either platform.
 *
 * `del`, `rd` and `Remove-Item` are cmd and PowerShell's own spellings; a command
 * line that reaches this guard may come from either shell, and the Windows names
 * are not a rarity on a Windows host — they are the ordinary way to delete there.
 */
const TREE_DELETERS = new Set([
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'remove-item',
  'ri',
  'delete-item',
  'srm',
])

/**
 * The programs that read `/s` as a switch rather than as the path `/s`.
 *
 * Only cmd's builtins do. `rm` takes `/s` as a directory name, so applying the
 * cmd reading to it would make `rm -r /etc` look like an option and pass.
 */
const CMD_STYLE = new Set(['del', 'erase', 'rd', 'rmdir', 'format'])

/** Programs that wipe a whole volume from its name alone, taking no target. */
const VOLUME_WIPERS = new Set([
  'format',
  'format-volume',
  'clear-disk',
  'initialize-disk',
  'diskpart',
])

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

/** How deep `sh -c 'sh -c ...'` is still unwrapped before it is only asked about. */
const MAX_SHELL_DEPTH = 4

/** Programs that run another program over a set the command line does not spell out. */
const RUNNERS = new Set(['find', 'xargs'])

/** Programs whose own job is destruction, when a runner hands them a whole set. */
const DESTRUCTIVE_PROGRAMS = new Set(['rm', 'rmdir', 'shred', 'unlink'])

/** `find`'s run-these-words predicates, whose payload follows the word. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** `xargs` options that take a separate value, so the value is not the program. */
const XARGS_VALUE_OPTIONS = new Set([
  '-a',
  '-d',
  '-E',
  '-I',
  '-L',
  '-n',
  '-P',
  '-s',
  '--arg-file',
  '--delimiter',
  '--eof',
  '--max-args',
  '--max-chars',
  '--max-lines',
  '--max-procs',
  '--process-slot-var',
  '--replace',
])

/** What one runner will execute, and where its set comes from. */
interface Delegation {
  /** The program the runner executes. */
  readonly program: string
  /** Whether the delegated program recurses, e.g. `rm -rf`. */
  readonly recursive: boolean
  /** The search root a `find` walks, when it names one. */
  readonly root?: string
  /** Whether the runner's own expression narrows the set before it acts. */
  readonly filtered: boolean
}

/**
 * Read the program a runner executes, when there is one.
 *
 * `find` and `xargs` do not name the files they act on: the set is whatever the
 * search walks or the pipe carries, which a command line cannot show. The one
 * thing it does show is the program that will receive it, so that is what is
 * judged — `find / -exec rm -rf {} +` says the same thing as `rm -rf /`.
 *
 * A narrowed search is not the same act: `find . -name '*.log' -delete` removes
 * the files a predicate picked out, and treating it as a whole-tree delete would
 * put a question on ordinary cleanup.
 * @param name - the runner's base name.
 * @param args - the words after the runner.
 * @returns the delegated program and the scope it runs over, or `undefined`.
 */
function delegatedProgram(name: string, args: readonly string[]): Delegation | undefined {
  if (name === 'find') {
    // `find`'s grammar is paths first, then the expression that acts on them, so
    // the leading run of non-option words is the search root.
    let start = 0
    while (start < args.length && !(args[start] ?? '').startsWith('-')) start += 1
    const root = start === 0 ? undefined : args[0]
    for (let index = start; index < args.length; index += 1) {
      const word = args[index] ?? ''
      // Anything between the root and the acting predicate is a filter, and a
      // filter is what makes the set the author's choice rather than the tree's.
      const filtered = index > start
      // `-delete` is `find` acting itself: every name the search reaches is
      // removed without a program in between, so it recurses by construction.
      if (word === '-delete') {
        return root === undefined
          ? { program: 'rm', recursive: true, filtered }
          : { program: 'rm', recursive: true, root, filtered }
      }
      if (!FIND_EXEC.has(word)) continue
      // Everything after the predicate is the command, up to the `+` or the `;`
      // that ends it. A `;` is a command separator to the lexer, so it is gone
      // by now and the payload simply runs to the end of the segment.
      const payload = programWords(
        args.slice(index + 1).filter((arg) => arg !== '+' && arg !== ';'),
      )
      const program = baseName(payload[0] ?? '')
      if (program === '') return undefined
      const flags = payload.slice(1)
      const recursive = hasShortOption(flags, 'rR') || flags.includes('--recursive')
      return root === undefined
        ? { program, recursive, filtered }
        : { program, recursive, root, filtered }
    }
    return undefined
  }
  // `xargs` takes its own options first, then the program. A value option that
  // was written attached (`-I{}`) loses its value to the lexer's brace handling,
  // so a word this would otherwise skip as a value is still read as the program
  // when it is one — a false question costs less than a missed delete.
  let index = 0
  while (index < args.length) {
    const word = args[index] ?? ''
    if (!word.startsWith('-')) break
    const takesValue = XARGS_VALUE_OPTIONS.has(word)
    const value = args[index + 1] ?? ''
    if (takesValue && !DESTRUCTIVE_PROGRAMS.has(baseName(value))) {
      index += 2
      continue
    }
    index += 1
  }
  const payload = programWords(args.slice(index))
  const program = baseName(payload[0] ?? '')
  if (program === '') return undefined
  const flags = payload.slice(1)
  return {
    program,
    recursive: hasShortOption(flags, 'rR') || flags.includes('--recursive'),
    filtered: false,
  }
}

/**
 * Every dangerous pattern one command segment performs.
 * @param segment - one command's words.
 * @param action - the configured policy.
 * @param depth - how many nested shells this call already unwrapped.
 * @returns the hits, in the order the patterns are considered.
 */
function hitsFor(segment: readonly string[], action: GuardAction, depth: number): GuardHit[] {
  const words = programWords(segment)
  const program = words[0]
  if (program === undefined) return []
  // PowerShell capitalises its verbs and nouns (`Remove-Item`), while cmd is
  // case-insensitive outright. Comparing every program name lowercased is the
  // only spelling-independent way to recognise the same act on either platform.
  const name = baseName(program).toLowerCase()
  const args = words.slice(1)
  const hits: GuardHit[] = []

  // The same act has a name per platform: `rm -rf`, cmd's `rd /s /q`, and
  // PowerShell's `Remove-Item -Recurse`. All of them take a target, and a target
  // that names a whole filesystem position is the hit. Only cmd's own builtins
  // read `/s` as a switch, which is why the program decides the option style.
  const cmdStyle = CMD_STYLE.has(name)
  if (TREE_DELETERS.has(name) && destroyTarget(args, cmdStyle) !== undefined) {
    hits.push(hit('rm -rf', action))
  }

  // A volume wiper takes no target: the volume it acts on comes from the drive
  // letter, or from the only disk there is. `format C:` and `Format-Volume` are
  // the same act as erasing the filesystem.
  if (VOLUME_WIPERS.has(name)) {
    const named = args.some((arg) => !isOption(arg, name === 'format') && DRIVE_LETTER.test(arg))
    const removal = args.some((arg) => /^-(remove|remove-data|removedata|force|full)$/i.test(arg))
    if (named || removal || name === 'diskpart') hits.push(hit('mkfs', action))
  }

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

  // A destructive program handed to `find -exec` or `xargs` acts on a set the
  // command line never spells out: everything a search walks, or everything a
  // pipe carries. The one thing it does show is the program that will receive
  // it, so that is what gets judged — `find / -exec rm -rf {} +` says the same
  // thing as `rm -rf /`.
  const runner = RUNNERS.has(name) ? delegatedProgram(name, args) : undefined
  if (runner !== undefined && DESTRUCTIVE_PROGRAMS.has(baseName(runner.program))) {
    // Three cases, and only one of them is an ordinary command. A search rooted
    // at a filesystem or a home directory is never scoped, whatever filters
    // follow. A search over an unnamed set — everything a pipe carries — cannot
    // be scoped either, so a recursive delete there is judged on the delete
    // alone. In between, a predicate between the root and the acting expression
    // narrows the set to names the author picked out, which is cleanup.
    const root = runner.root
    const dangerous =
      root === undefined
        ? runner.recursive
        : isRootTarget(root) || (!runner.filtered && isDangerousTarget(root))
    if (dangerous) hits.push(hit(`${name} ${baseName(runner.program)}`, action))
  }

  // `sh -c '<command>'` names no pattern itself; the command inside it does,
  // and it is read as a command line in its own right. Past the depth limit the
  // nested text is no longer worth reading, and an unread shell is a question.
  const script = shellArgument(words)
  if (script !== undefined) {
    if (depth >= MAX_SHELL_DEPTH) return [...hits, hit('shell -c', action)]
    for (const nested of segments(tokenize(script, depth + 1))) {
      hits.push(...hitsFor(nested, action, depth + 1))
    }
  }

  return hits
}

/**
 * Whether a target names a filesystem or a home directory, where no delete is
 * an ordinary one, whatever a filter in front of it selected.
 * @param target - a word naming what a delete acts on.
 * @returns whether deleting from it can never be a scoped act.
 */
function isRootTarget(target: string): boolean {
  const value = target.replace(/\\/g, '/')
  const normalized = /^\/+$/.test(value) ? '/' : value.replace(/\/+$/, '')
  if (ROOT_TARGETS.has(normalized)) return true
  if (normalized.endsWith('/*')) {
    const parent = normalized.slice(0, -2)
    if (parent === '' || ROOT_TARGETS.has(parent)) return true
  }
  return false
}

/**
 * Whether deleting this target is a destructive act rather than an ordinary one.
 * @param target - a non-option word from a delete command.
 * @returns whether the target is a filesystem root or a whole system directory.
 */
export function isDangerousTarget(target: string): boolean {
  const normalized = normalizeTarget(target)
  if (namesWholePlace(normalized)) return true
  // `rm -rf ~/*`, `rm -rf /*` and `rm -rf C:/*` remove the contents of the
  // directory the forms above name, which is the same act on the same tree.
  // Matching the whole word would miss every one of them, so the part before
  // the wildcard is what is compared.
  if (!normalized.endsWith('/*')) return false
  const parent = normalized.slice(0, -2)
  return parent === '' || namesWholePlace(parent)
}

/**
 * Normalise a path-like word so that the spellings a shell treats as the same
 * place compare equal.
 *
 * A run of separators is the root however it was written, and a trailing
 * separator names the same directory as the form without it. Both platforms'
 * separators are folded to `/` because the command line may come from either.
 * @param target - the word as written.
 * @returns the spelling used for comparison.
 */
function normalizeTarget(target: string): string {
  // Folded to lower case as well: the Windows variable spellings this compares
  // (`$env:USERPROFILE`, `%USERPROFILE%`) are case-insensitive in the shell that
  // expands them, and every path-like entry is case-insensitive on that platform.
  const value = target.replace(/\\/g, '/').toLowerCase()
  return /^\/+$/.test(value) ? '/' : value.replace(/\/+$/, '')
}

/**
 * Whether a normalised target names a whole filesystem position rather than a
 * place inside one.
 * @param normalized - the output of {@link normalizeTarget}.
 * @returns whether no delete from it can be scoped.
 */
function namesWholePlace(normalized: string): boolean {
  if (DANGEROUS_TARGETS.has(normalized)) return true
  // `C:`, `C:/` and `C:\` are one place to every shell on Windows; a recursive
  // delete aimed at any of them takes the drive.
  if (DRIVE_ROOT.test(normalized)) return true
  return SYSTEM_DIRECTORY.test(normalized)
}

/**
 * Whether a word is an option rather than a target.
 *
 * `-r` is an option on every platform. `\/s` is one only to cmd's own programs:
 * to `rm` it is the path `/s`, so reading it as a switch would make `rm -r /etc`
 * pass. Which program is asking is therefore part of the question.
 * @param word - one argument.
 * @param cmdStyle - whether the program is a cmd builtin, where `/` begins a switch.
 * @returns whether the argument names an option.
 */
function isOption(word: string, cmdStyle: boolean): boolean {
  if (word.startsWith('-')) return word.length > 1
  if (!cmdStyle) return false
  // A bare `/` is a target, not a switch, which is why a run of letters is
  // required — and why `del /f /s /q C:\` reads as four switches and a target.
  return /^\/[a-z]+$/i.test(word)
}

/**
 * Whether a delete command was asked to recurse, in either platform's spelling.
 * @param args - the words after the program.
 * @param cmdStyle - whether the program is a cmd builtin, where `/s` is a switch.
 * @returns whether the whole tree under each target is in scope.
 */
function wantsRecursion(args: readonly string[], cmdStyle: boolean): boolean {
  if (hasShortOption(args, 'rR')) return true
  // PowerShell spells its switches out and capitalises them: `-Recurse`,
  // `-Recurse:$true`. Comparing the lowercased word is what covers both shells.
  if (args.some((arg) => /^-(recurse|r)(:|$)/i.test(arg))) return true
  if (args.some((arg) => arg.toLowerCase() === '--recursive')) return true
  return cmdStyle && args.some((arg) => /^\/s$/i.test(arg))
}

/**
 * The target of a recursive delete, when there is one to judge.
 * @param args - the words after the deleting program.
 * @param cmdStyle - whether the program is a cmd builtin, where `/` begins a switch.
 * @returns the outcome: the destructive target found, `'unknown'` when the delete
 * recursively takes a set the line never spells out, or `undefined` for an
 * ordinary delete.
 */
function destroyTarget(args: readonly string[], cmdStyle: boolean): string | 'unknown' | undefined {
  if (!wantsRecursion(args, cmdStyle)) return undefined
  const targets = args.filter((arg) => !isOption(arg, cmdStyle))
  if (targets.length === 0) {
    // `rm -rf $(cat list)` puts the target in a substitution, which is read as a
    // command of its own — so this segment names no operand at all. A recursive
    // delete with nothing to delete is either a mistake or a target the line does
    // not show, and a question costs less than a silent delete.
    return 'unknown'
  }
  return targets.find((arg) => isDangerousTarget(arg))
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
 * Classify one shell command.
 * @param command - the command line the agent is about to run.
 * @param config - resolved plugin configuration.
 * @returns the strictest recognised operation, or `undefined` for an ordinary command.
 */
export function detectCommand(command: string, config: Config): GuardHit | undefined {
  if (!config.commandGuard.enabled.get()) return undefined
  const action = config.commandGuard.dangerousShell.get()

  const hits: GuardHit[] = []
  // Both of these are syntax rather than an invocation, so they are tested
  // against the whole line rather than a segmented word list.
  if (FORK_BOMB.test(command)) hits.push(hit('fork bomb', action))
  if (DEVICE_REDIRECT.test(command)) hits.push(hit('raw device write', action))
  for (const segment of segments(tokenize(command))) hits.push(...hitsFor(segment, action, 0))

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
