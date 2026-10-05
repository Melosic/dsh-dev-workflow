import type { Config } from '../config.js'
import { commandOf, gitInvocations } from '../shell.js'
import { createGuard, hasShortOption, strictest } from './shared.js'
import type { GuardHit, GuardOptions } from './shared.js'

// git-guard: the half of the plugin that protects work rather than conventions.
//
// It rides on the same `tools/pre-execute` waterfall as the pre-commit trigger,
// so it sees exactly the commands the agent is about to run. Nothing here parses
// a shell: `src/shell.ts` already reduced the command line to `git <subcommand>`
// words, and this file only classifies those words. The waterfall itself lives in
// `./shared.ts`, together with the three guards that follow it.
//
// The default for every operation is `ask`, never `allow`. A guard that silently
// permits by default is not a guard.

export type { GuardAction, GuardHit, GuardOptions } from './shared.js'
export { hasShortOption } from './shared.js'

/** Options this guard needs. Same shape as every other guard's. */
export type GitGuardOptions = GuardOptions

/**
 * Classify a `git push` as forced.
 * @param args - the words after `push`.
 * @param config - resolved plugin configuration.
 * @returns the hit, or `undefined` for an ordinary push.
 */
function pushHit(args: readonly string[], config: Config): GuardHit | undefined {
  // `--force-with-lease` is the form the guard steers people towards, so a push
  // carrying it is not a hit.
  if (args.some((word) => word.startsWith('--force-with-lease'))) return undefined
  const forced =
    args.includes('--force') ||
    hasShortOption(args, 'f') ||
    // A leading `+` on a refspec means "overwrite this ref".
    args.some((word) => word.startsWith('+') && word.length > 1 && !word.startsWith('++'))
  if (!forced) return undefined
  return {
    reason: 'security.guard.force_push',
    action: config.gitGuard.forcePush,
    suggestion: 'security.guard.suggest_force_with_lease',
  }
}

/**
 * Find the destructive operation in one shell command.
 * @param command - the command line the agent is about to run.
 * @param config - resolved plugin configuration.
 * @returns the strictest hit, or `undefined` when nothing is destructive.
 */
export function detectGuard(command: string, config: Config): GuardHit | undefined {
  if (!config.gitGuard.enabled) return undefined
  const guard = config.gitGuard
  const hits: GuardHit[] = []

  for (const { subcommand, args } of gitInvocations(command)) {
    let hit: GuardHit | undefined
    if (subcommand === 'push') {
      hit = pushHit(args, config)
    } else if (subcommand === 'reset' && args.includes('--hard')) {
      hit = { reason: 'security.guard.hard_reset', action: guard.hardReset }
    } else if (subcommand === 'rebase') {
      hit = { reason: 'security.guard.rebase', action: guard.rebase }
    } else if (subcommand === 'clean' && (args.includes('--force') || hasShortOption(args, 'f'))) {
      hit = { reason: 'security.guard.clean_force', action: guard.cleanForce }
    } else if (subcommand === 'commit' && args.includes('--amend')) {
      hit = { reason: 'security.guard.amend', action: guard.amend }
    } else if (
      subcommand === 'branch' &&
      (hasShortOption(args, 'D') || (args.includes('--delete') && args.includes('--force')))
    ) {
      hit = { reason: 'security.guard.branch_delete', action: guard.branchDelete }
    } else if (subcommand === 'checkout') {
      // `checkout -- <path>` restores from the index, discarding whatever was
      // edited in those files. A trailing `--` with nothing after it discards
      // nothing.
      const separator = args.indexOf('--')
      if (separator !== -1 && separator < args.length - 1) {
        hit = { reason: 'security.guard.checkout_discard', action: guard.checkoutDiscard }
      }
    }
    if (hit !== undefined) hits.push(hit)

    // `--no-verify` is a property of the invocation rather than of one
    // operation, so it is checked for every subcommand — and it is recorded
    // after the operation it modifies, so that a tie reports the operation.
    // It defaults to `ask` and never to `deny`: it is the escape hatch for
    // when the hooks themselves are wrong, and closing it would leave no way
    // through.
    if (args.includes('--no-verify')) {
      hits.push({ reason: 'security.guard.no_verify', action: guard.noVerify })
    }
  }

  return strictest(hits)
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
    detect: (exec) => {
      const command = commandOf(exec.arguments)
      return command === undefined ? undefined : detectGuard(command, options.config())
    },
  })
}
