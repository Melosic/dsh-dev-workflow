import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { createTranslator } from '../i18n.js'
import type { Translate, TranslationParams } from '../i18n.js'
import type { WorkflowState } from '../state.js'

// The guards are four classifiers over one gate. This file holds what they share:
// how a hit is ranked, rendered, and turned into a decision, plus the waterfall
// order every one of them follows. A guard supplies nothing but `detect`.
//
// The order below is load-bearing and identical for all of them: an aborted call
// stays aborted, a refusal is never weakened into a question, and a hit is
// counted before the decision settles so `/dev-workflow status` reports what a
// guard saw even when another gate settles the call first.
//
// The default for every policy is `ask`, never `allow`. A guard that silently
// permits by default is not a guard.

/** What a guard may do about one recognised operation. */
export type GuardAction = 'deny' | 'ask' | 'allow'

/** One recognised operation. */
export interface GuardHit {
  /**
   * Dictionary key naming the operation, e.g. `security.guard.hard_reset`. The
   * same key is counted in the hit tally, so `/dev-workflow status` can read it
   * out in whatever language the session is using.
   */
  readonly reason: string
  /** The policy configured for it. */
  readonly action: GuardAction
  /** Dictionary key of a safer alternative, when one exists. */
  readonly suggestion?: string
  /**
   * Values for the `{placeholders}` in this hit's keys.
   *
   * Deliberately carries only a *kind* — a pattern name, a file base name — and
   * never the matched material itself: this text reaches the model.
   */
  readonly params?: TranslationParams
}

/** Options every guard needs. Everything is a getter: the runtime owns it. */
export interface GuardOptions {
  /** Resolved plugin configuration. */
  readonly config: () => Config
  /** Translator for the locale in effect. */
  readonly t: () => Translate
  /** Where guard hits are counted, for `/dev-workflow status`. */
  readonly state: WorkflowState
  /** Diagnostic sink; debug level, so the default profile stays quiet. */
  readonly log: (message: string) => void
  /**
   * Security audit sink, called once per recognised hit.
   *
   * Optional so a bare guard can be driven on its own, but the runtime always
   * supplies it: a guard that fires without leaving a record is a guard nobody
   * can review afterwards.
   */
  readonly audit?: (hit: GuardHit, exec: ToolExecution) => void
}

/** What a concrete guard adds to the shared options. */
export interface GuardDefinition extends GuardOptions {
  /** Short name used in the log line, e.g. `git guard`. */
  readonly label: string
  /**
   * Classify one call.
   * @param exec - the call the agent is about to make.
   * @returns the recognised operation, or `undefined` for an ordinary call.
   */
  readonly detect: (exec: ToolExecution) => GuardHit | undefined
}

/** Severity order used to pick one decision when a line does several things. */
export const RANK: Readonly<Record<GuardAction, number>> = { allow: 0, ask: 1, deny: 2 }

/**
 * Whether a short-option cluster contains any of `letters`.
 * `-fd` contains `f`; `--force` never does, because long options are matched by
 * name instead.
 * @param words - the command words to scan.
 * @param letters - the option letters to look for.
 * @returns whether any word is a cluster containing one of them.
 */
export function hasShortOption(words: readonly string[], letters: string): boolean {
  return words.some(
    (word) =>
      word.startsWith('-') &&
      !word.startsWith('--') &&
      [...word.slice(1)].some((letter) => letters.includes(letter)),
  )
}

/**
 * Pick the strictest of several hits.
 * @param hits - every operation recognised in one call, in order.
 * @returns the strictest, keeping the first on a tie.
 */
export function strictest(hits: readonly GuardHit[]): GuardHit | undefined {
  let best: GuardHit | undefined
  for (const hit of hits) {
    if (best === undefined || RANK[hit.action] > RANK[best.action]) best = hit
  }
  return best
}

/**
 * Render one hit's explanation, with its safer alternative when it has one.
 * @param hit - the recognised operation.
 * @param t - translator to render with.
 * @returns the text of the reason.
 */
export function explain(hit: GuardHit, t: Translate): string {
  const reason = t(hit.reason, hit.params)
  return hit.suggestion === undefined ? reason : `${reason}\n${t(hit.suggestion, hit.params)}`
}

/**
 * Turn a hit into the decision this gate returns.
 * @param hit - the recognised operation and the policy that applies.
 * @param t - translator for the plugin's own locale.
 * @returns the decision for the tool dispatcher.
 */
export function decide(hit: GuardHit, t: Translate): PreToolDecision {
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
 * Build the `tools/pre-execute` listener for one classifier.
 * @param definition - the classifier plus the shared options.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createGuard(
  definition: GuardDefinition,
): (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const hit = definition.detect(exec)
    if (hit === undefined || hit.action === 'allow') return next()
    if (exec.signal.aborted) return { kind: 'cancel' }

    // Counted and audited before the decision is settled, so the status line and
    // the audit log report what the guard saw even when another gate settles the
    // call first.
    definition.state.recordGuardHit(hit.reason)
    definition.log(`[dsh-dev-workflow] ${definition.label}: ${hit.reason}`)
    definition.audit?.(hit, exec)

    const t = definition.t()
    const downstream = await next()
    // An aborted call stays aborted, and a refusal by another gate is never
    // weakened into a question.
    if (downstream.kind === 'cancel') return downstream
    if (hit.action === 'deny') return decide(hit, t)
    if (downstream.kind === 'deny') return downstream
    // Otherwise the call was going to proceed. The guard's own question replaces
    // any other `ask`, so the reason shown names the operation that was actually
    // recognised; the approval it needs is the same either way.
    return decide(hit, t)
  }
}
