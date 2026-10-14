import type { Config } from '../config.js'
import { commandOf, gitInvocations } from '../shell.js'
import { createGuardApprover } from './approval.js'
import type { ApprovalService } from './approval.js'
import { createGuard, hasShortOption, strictest } from './shared.js'
import type { GuardHit, GuardOptions } from './shared.js'

// git-guard: the half of the plugin that protects work rather than conventions.
//
// It rides on the same `tools/pre-execute` waterfall as the pre-commit trigger,
// so it sees exactly the commands the agent is about to run. Nothing here parses
// a shell: `src/shell.ts` already reduced the command line to `git <subcommand>`
// words, and this file only classifies those words. The waterfall itself lives in
// `./shared.ts`, together with the four guards that follow it.
//
// The default for every operation is `ask`, never `allow`. A guard that silently
// permits by default is not a guard.

export type { GuardAction, GuardHit, GuardOptions } from './shared.js'
export { hasShortOption } from './shared.js'

/** Options this guard needs. Same shape as every other guard's, plus the seam. */
export type GitGuardOptions = GuardOptions & {
  /**
   * The approval seam, read at call time. Absent when the profile composes no
   * approval service, and in a test that drives this guard on its own.
   */
  readonly approval?: () => ApprovalService | undefined
}

/**
 * Classify a `git push` as forced.
 * @param args - the words after `push`.
 * @param config - resolved plugin configuration.
 * @returns the hit, or `undefined` for an ordinary push.
 */
function pushHit(args: readonly string[], config: Config): GuardHit | undefined {
  // `--force-with-lease` on its own needs no special case here: it matches none
  // of the words below, so it stays an ordinary push. It must not short-circuit,
  // because plain `--force` overrides the lease and clobbers the remote anyway.
  //
  // `--mirror` is the same act by another name: it makes the remote match the
  // local refs exactly, which deletes every ref the local repository does not
  // have. Requiring the word `--force` would leave that spelling unguarded.
  const forced =
    args.includes('--force') ||
    args.includes('--mirror') ||
    hasShortOption(args, 'f') ||
    // A leading `+` on a refspec means "overwrite this ref".
    args.some((word) => word.startsWith('+') && word.length > 1 && !word.startsWith('++'))
  if (forced) {
    return {
      reason: 'security.guard.force_push',
      action: config.gitGuard.forcePush.get(),
      suggestion: 'security.guard.suggest_force_with_lease',
    }
  }
  // Deleting a remote branch discards it everywhere it has been fetched, which
  // is the same loss `git branch -D` causes locally — so it answers to the same
  // policy rather than to a new one. Four spellings delete: `--delete`, `-d`,
  // an empty left side on a refspec (`git push origin :topic`), and `--prune`.
  // A force delete is already caught above, where the stricter `forcePush`
  // policy wins.
  const deletes =
    args.includes('--delete') ||
    hasShortOption(args, 'd') ||
    args.some((word) => word.startsWith(':') && word.length > 1)
  if (deletes) {
    return { reason: 'security.guard.branch_delete', action: config.gitGuard.branchDelete.get() }
  }
  return undefined
}

/** Options that only continue or unwind a rebase already in progress. */
const REBASE_RECOVERY = new Set(['--continue', '--abort', '--skip'])

/**
 * The file or tree a `checkout`/`restore` is pointed at, when it names one.
 *
 * Only the words after `--` are read as paths, exactly as git reads them, plus
 * the one reserved spelling that needs no separator: a plain `.` restores the
 * whole working tree. Reading any bare word as a path instead would turn a
 * branch switch into an alarm, and the names that matter are the ones a person
 * types.
 * @param args - the words after the subcommand.
 * @returns the target word, or `undefined` when the command names no path.
 */
function restoreTarget(args: readonly string[]): string | undefined {
  const separator = args.indexOf('--')
  if (separator !== -1) return args[separator + 1]
  const plain = args.find((word) => !word.startsWith('-'))
  return plain === '.' || plain === './' ? plain : undefined
}

/**
 * Whether a `checkout` or `restore` replaces files in the working tree.
 *
 * `git checkout .` and `git restore .` throw away uncommitted edits exactly as
 * `git checkout -- .` does — the modern spelling of the same loss. `git restore
 * --staged` moves changes back to the working tree and discards nothing, and a
 * restore from another commit is how a file is recovered, so neither is a hit.
 * @param args - the words after the subcommand.
 * @returns whether the command overwrites working-tree files.
 */
function discardsWork(args: readonly string[]): boolean {
  const staged = args.includes('--staged') || args.includes('-S')
  if (staged) return false
  const source = args.find((word) => word.startsWith('--source'))
  return source === undefined || source === '--source=HEAD' || source === '--source'
}

/**
 * Find every destructive operation in one shell command.
 *
 * A single line can do more than one thing: `git push -f --no-verify` is a force
 * push *and* a hook bypass, and each is worth counting on its own. The decision
 * still comes from the strictest of them.
 * @param command - the command line the agent is about to run.
 * @param config - resolved plugin configuration.
 * @returns every hit, strictest last, or an empty array when nothing is destructive.
 */
export function detectAllGuards(command: string, config: Config): GuardHit[] {
  if (!config.gitGuard.enabled.get()) return []
  const guard = config.gitGuard
  const hits: GuardHit[] = []

  for (const { subcommand, args } of gitInvocations(command)) {
    if (subcommand === 'push') {
      const push = pushHit(args, config)
      if (push !== undefined) hits.push(push)
    } else if (subcommand === 'reset' && args.includes('--hard')) {
      hits.push({ reason: 'security.guard.hard_reset', action: guard.hardReset.get() })
    } else if (
      subcommand === 'rebase' &&
      !args.some((word) => REBASE_RECOVERY.has(word)) &&
      // `--exec` in the same call runs a command per commit, so an invocation
      // that continues a rebase and also executes is not the safe spelling.
      !args.includes('--exec') &&
      !hasShortOption(args, 'x')
    ) {
      hits.push({ reason: 'security.guard.rebase', action: guard.rebase.get() })
    } else if (subcommand === 'clean' && (args.includes('--force') || hasShortOption(args, 'f'))) {
      hits.push({ reason: 'security.guard.clean_force', action: guard.cleanForce.get() })
    } else if (subcommand === 'commit' && args.includes('--amend')) {
      hits.push({ reason: 'security.guard.amend', action: guard.amend.get() })
    } else if (
      subcommand === 'branch' &&
      (hasShortOption(args, 'D') || (args.includes('--delete') && args.includes('--force')))
    ) {
      hits.push({ reason: 'security.guard.branch_delete', action: guard.branchDelete.get() })
    } else if (subcommand === 'checkout' || subcommand === 'restore') {
      // `checkout -- <path>` and `checkout .` both restore from the index,
      // discarding whatever was edited in those files, and `restore <path>` is
      // the modern spelling of the same loss. `restore --staged` moves changes
      // back to the working tree and discards nothing, so it is not a hit.
      const target = restoreTarget(args)
      if (target !== undefined && discardsWork(args)) {
        hits.push({
          reason: 'security.guard.checkout_discard',
          action: guard.checkoutDiscard.get(),
        })
      }
    }

    // `--no-verify` is a property of the invocation rather than of one
    // operation, so it is checked for every subcommand — and it is recorded
    // after the operation it modifies, so that a tie reports the operation.
    // It defaults to `ask` and never to `deny`: it is the escape hatch for
    // when the hooks themselves are wrong, and closing it would leave no way
    // through.
    if (args.includes('--no-verify')) {
      hits.push({ reason: 'security.guard.no_verify', action: guard.noVerify.get() })
    }
  }

  return hits
}

/**
 * Find the destructive operation in one shell command.
 * @param command - the command line the agent is about to run.
 * @param config - resolved plugin configuration.
 * @returns the strictest hit, or `undefined` when nothing is destructive.
 */
export function detectGuard(command: string, config: Config): GuardHit | undefined {
  return strictest(detectAllGuards(command, config))
}

/**
 * Build the `tools/pre-execute` listener for destructive git commands.
 * @param options - configuration, translator, hit tally, and logging.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createGitGuard(options: GitGuardOptions): ReturnType<typeof createGuard> {
  return createGuard({
    ...options,
    label: 'git guard',
    // The switch that remembers an approval lives in `gitGuard`, so this is the
    // one guard that asks the user itself instead of leaving it to the
    // dispatcher: only the asker can see the answer.
    approver: createGuardApprover({
      approval: options.approval ?? (() => undefined),
      state: options.state,
      remembers: () => options.config().gitGuard.rememberApproved.get(),
    }),
    detect: (exec) => {
      const command = commandOf(exec.arguments)
      return command === undefined ? undefined : detectGuard(command, options.config())
    },
    // Every destructive operation on the line is counted, not only the one whose
    // policy wins: the status line is a record of what the plugin saw.
    detectAll: (exec) => {
      const command = commandOf(exec.arguments)
      return command === undefined ? [] : detectAllGuards(command, options.config())
    },
  })
}
