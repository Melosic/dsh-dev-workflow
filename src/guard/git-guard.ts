import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { createTranslator } from '../i18n.js'
import type { Translate } from '../i18n.js'
import type { WorkflowState } from '../state.js'
import { commandOf, gitInvocations } from '../shell.js'

// git-guard: the half of the plugin that protects work rather than conventions.
//
// It rides on the same `tools/pre-execute` waterfall as the pre-commit trigger,
// so it sees exactly the commands the agent is about to run. Nothing here parses
// a shell: `src/shell.ts` already reduced the command line to `git <subcommand>`
// words, and this file only classifies those words.
//
// The default for every operation is `ask`, never `allow`. A guard that silently
// permits by default is not a guard.

/** What the guard may do about one operation. */
export type GuardAction = 'deny' | 'ask' | 'allow'

/** One recognised destructive operation. */
export interface GuardHit {
  /**
   * Dictionary key naming the operation, e.g. `security.guard.hard_reset`. The
   * same key is counted in the hit tally, so `/dev-workflow status` can read it
   * out in whatever language the session is using.
   */
  readonly reason: string
  /** The safest action configured for it when several hits overlap. */
  readonly action: GuardAction
  /** Dictionary key of a safer alternative, when one exists. */
  readonly suggestion?: string
}

/** Options the guard needs. Everything is a getter: the runtime owns it. */
export interface GitGuardOptions {
  /** Resolved plugin configuration. */
  readonly config: () => Config
  /** Translator for the locale in effect. */
  readonly t: () => Translate
  /** Where guard hits are counted, for `/dev-workflow status`. */
  readonly state: WorkflowState
  /** Diagnostic sink; debug level, so the default profile stays quiet. */
  readonly log: (message: string) => void
}

/** Severity order used to pick one decision when a line does several things. */
const RANK: Readonly<Record<GuardAction, number>> = { allow: 0, ask: 1, deny: 2 }

/**
 * Whether a short-option cluster contains any of `letters`.
 * `-fd` contains `f`; `--force` never does, because long options are matched by
 * name instead.
 * @param words - the command words to scan.
 * @param letters - the option letters to look for.
 * @returns whether any word is a cluster containing one of them.
 */
function hasShortOption(words: readonly string[], letters: string): boolean {
  return words.some(
    (word) =>
      word.startsWith('-') &&
      !word.startsWith('--') &&
      [...word.slice(1)].some((letter) => letters.includes(letter)),
  )
}

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

  let strictest: GuardHit | undefined
  for (const hit of hits) {
    if (strictest === undefined || RANK[hit.action] > RANK[strictest.action]) strictest = hit
  }
  return strictest
}

/**
 * Render one hit's explanation, with its safer alternative when it has one.
 * @param hit - the recognised operation.
 * @param t - translator to render with.
 * @returns the text of the reason.
 */
function explain(hit: GuardHit, t: Translate): string {
  const reason = t(hit.reason)
  return hit.suggestion === undefined ? reason : `${reason}\n${t(hit.suggestion)}`
}

/**
 * Turn a hit into the decision this gate returns.
 * @param hit - the recognised operation and the policy that applies.
 * @param t - translator for the plugin's own locale.
 * @returns the decision for the tool dispatcher.
 */
function decide(hit: GuardHit, t: Translate): PreToolDecision {
  if (hit.action === 'deny') return { kind: 'deny', reason: explain(hit, t) }
  // The approval prompt picks a language by the client's locale, which is not
  // necessarily the plugin's, so both sides are rendered. The Chinese key is the
  // literal `zh`: the client lower-cases a locale and falls back to `en`.
  return {
    kind: 'ask',
    reason: explain(hit, t),
    displayReason: {
      en: explain(hit, createTranslator('en-US')),
      zh: explain(hit, createTranslator('zh-CN')),
    },
  }
}

/**
 * Build the `tools/pre-execute` listener for destructive git commands.
 * @param options - configuration, translator, hit tally, and logging.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createGitGuard(
  options: GitGuardOptions,
): (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const command = commandOf(exec.arguments)
    const hit = command === undefined ? undefined : detectGuard(command, options.config())
    if (hit === undefined || hit.action === 'allow') return next()
    if (exec.signal.aborted) return { kind: 'cancel' }

    // Counted before the decision is settled, so `/dev-workflow status` reports
    // what the guard saw even when another gate settles the call first.
    options.state.recordGuardHit(hit.reason)
    options.log(`[dsh-dev-workflow] git guard: ${hit.reason}`)

    const t = options.t()
    const downstream = await next()
    // An aborted call stays aborted, and a refusal by another gate is never
    // weakened into a question.
    if (downstream.kind === 'cancel') return downstream
    if (hit.action === 'deny') return decide(hit, t)
    if (downstream.kind === 'deny') return downstream
    // Otherwise the call was going to proceed. The guard's own question
    // replaces any other `ask`, so the reason shown names the operation that
    // actually discards work; the approval it needs is the same either way.
    return decide(hit, t)
  }
}
