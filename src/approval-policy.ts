import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Translate } from './i18n.js'

// A question nobody will be asked is not a question.
//
// The approval policy `never` — which the `danger-full-access` preset sets — is
// not "approve everything". `dsh-user-approval` returns `rejected` from
// `decide()` *before* it consults any answerer
// (`dsh-user-approval/lib/index.js:175`), and the dispatcher then reports that
// refusal as ``the user rejected tool "..."`` (`dsh-tools/lib/index.js:3468`).
// A plugin that returns `ask` under that policy is therefore answered by nobody
// while the model is told the user decided something the user was never shown.
//
// The outcome cannot be improved — the operation is refused either way — but the
// account of it can be. This lets every gate this plugin owns refuse on its own
// behalf and name the real cause, and the way out.
//
// Deliberately dependency-free: both `./guard/*` and `./triggers/*` use it, and
// `./guard/approval.ts` imports `./guard/shared.ts`, so a shared module that
// reached back into either would close a cycle.

/** An approval seam that reports the policy its asks resolve under. */
export interface ApprovalPolicyReporter {
  /**
   * The policy one session's asks resolve under.
   *
   * Optional because a stand-in that only answers questions reports no policy,
   * and because the real service declares it optional too.
   * @param session - the session whose own log supplies the override.
   * @returns `ask` or `never`, or `undefined` when the seam does not say.
   */
  effectivePolicy?(session: unknown): string | undefined
}

/**
 * Restate a question as the refusal that would actually happen, when the session
 * cannot be asked: when its approval policy is `never`, the refusal is already
 * certain, so the gate should return it itself and say why.
 *
 * A seam that does not report a policy, or a call with no session, is read as
 * "cannot know" and the decision passes through unchanged — the gate asks, and
 * the dispatcher settles it. Guessing `never` there would turn a working prompt
 * into a refusal.
 * @param decision - the decision the gate was about to return.
 * @param t - translator for the plugin's own locale.
 * @param approval - the seam, or the getter that answers `undefined` without one.
 * @param session - the session the question would resolve under.
 * @returns the refusal, or `decision` unchanged when the question stands.
 */
export function unaskable(
  decision: PreToolDecision,
  t: Translate,
  approval: (() => ApprovalPolicyReporter | undefined) | undefined,
  session: unknown,
): PreToolDecision {
  if (decision.kind !== 'ask') return decision
  const service = approval?.()
  if (service === undefined || typeof service.effectivePolicy !== 'function') return decision
  if (session === undefined || session === null) return decision
  if (service.effectivePolicy(session) !== 'never') return decision
  // The gate's own words name the operation, which is what the user needs in
  // order to decide; only the account of who was asked is missing from what the
  // dispatcher would have said. The bilingual `displayReason` is dropped with
  // the question it belonged to.
  return { kind: 'deny', reason: `${decision.reason}\n${t('approval.disabled')}` }
}
