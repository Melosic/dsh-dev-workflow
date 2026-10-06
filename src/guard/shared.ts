import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalPolicyReporter } from '../approval-policy.js'
import { unaskable } from '../approval-policy.js'
import type { Config } from '../config.js'
import { createTranslator } from '../i18n.js'
import type { Translate, TranslationParams } from '../i18n.js'
import type { WorkflowState } from '../state.js'

// The guards are five classifiers over one gate. This file holds what they share:
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

/**
 * A seam that asks the user a question the guard can read the answer to.
 *
 * The tool dispatcher asks on the guard's behalf when the guard returns `ask`,
 * but it never reports the outcome back — an approval applies only to the
 * request it answered. A policy that wants to remember the answer therefore has
 * to ask itself. Supplied only by the guards whose configuration offers that.
 */
export interface GuardApprover {
  /**
   * Whether this hit's policy remembers an approval.
   * @param hit - the recognised operation.
   * @returns whether an answer about this hit is worth remembering.
   */
  readonly remembers: (hit: GuardHit) => boolean
  /**
   * Whether this exact operation was already approved in this session.
   * @param hit - the recognised operation.
   * @param exec - the call the agent is about to make.
   * @returns whether the question was already answered with a yes.
   */
  readonly approved: (hit: GuardHit, exec: ToolExecution) => boolean
  /**
   * Remember an operation the user just approved.
   * @param hit - the recognised operation.
   * @param exec - the call the agent is about to make.
   */
  readonly remember: (hit: GuardHit, exec: ToolExecution) => void
  /**
   * Ask the user about one operation, and read the answer.
   * @param hit - the recognised operation.
   * @param exec - the call the agent is about to make.
   * @param t - translator for the plugin's own locale.
   * @returns `undefined` when the user approved, so the caller remembers it;
   * otherwise the decision that settles the call.
   */
  readonly ask: (
    hit: GuardHit,
    exec: ToolExecution,
    t: Translate,
  ) => Promise<PreToolDecision | undefined>
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
  /**
   * Asks the user on the guard's behalf, for a guard whose policy remembers the
   * answer. Optional: the other four guards never ask themselves.
   */
  readonly approver?: GuardApprover
  /**
   * The approval seam, read only for the policy a question resolves under.
   *
   * Optional: without it every decision is returned as before, which is what a
   * profile with no approval service composed already gets.
   */
  readonly approval?: () => ApprovalPolicyReporter | undefined
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
    const session = exec.agent?.session
    const downstream = await next()
    // An aborted call stays aborted, and a refusal by another gate is never
    // weakened into a question.
    if (downstream.kind === 'cancel') return downstream
    if (hit.action === 'deny') return decide(hit, t)
    if (downstream.kind === 'deny') return downstream

    const approver = definition.approver
    if (approver !== undefined && approver.remembers(hit)) {
      // Already answered in this session. The operation may proceed, and any
      // question another gate still wants to ask stays that gate's to ask.
      if (approver.approved(hit, exec)) return downstream
      // Ask only when this guard's question would be the one the user answers.
      // If another gate already asks, its outcome is not ours to remember, so
      // the question stays with the dispatcher — the behaviour with the policy
      // switched off.
      if (downstream.kind === 'allow') {
        const refused = await approver.ask(hit, exec, t)
        if (refused !== undefined) return refused
        approver.remember(hit, exec)
        return { kind: 'allow' }
      }
    }

    // Otherwise the call was going to proceed. The guard's own question replaces
    // any other `ask`, so the reason shown names the operation that was actually
    // recognised; the approval it needs is the same either way.
    return unaskable(decide(hit, t), t, definition.approval, session)
  }
}
