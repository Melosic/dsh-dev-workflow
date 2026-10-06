import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { unaskable } from '../approval-policy.js'
import { fingerprint } from '../checks.js'
import type { WorkflowState } from '../state.js'
import { decide } from './shared.js'
import type { GuardApprover } from './shared.js'

// Remembered guard approvals, for the `rememberApproved` policy.
//
// The dispatcher answers a guard's `ask` through the approval seam and keeps the
// outcome to itself — deliberately, because a grant applies only to the request
// it answered and the vocabulary has no "allow always". So a guard whose policy
// remembers has to ask through the same seam itself and read the answer.
//
// Nothing here is injected: the seam is read at call time, so a profile that
// composes no approval service still mounts this plugin, and the question then
// falls back to the dispatcher's own prompt.

/** One answer from the approval seam. `allowed-once` is the only grant. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One question for the approval seam. */
export interface ApprovalRequest {
  readonly agent: unknown
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/**
 * The part of the approval service this plugin uses.
 *
 * The package ships no types of its own, so the shape is described here — the
 * same choice `src/index.ts` makes for the settings service. The seam is read
 * opportunistically through `ctx.get`, never declared in `inject`.
 */
export interface ApprovalService {
  /**
   * Ask the composed answerers about one call.
   * @param request - the agent, the tool, and why it is being asked.
   * @returns the resolved outcome; `allowed-once` is the only grant.
   */
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
  /**
   * The policy this session's asks resolve under, when the service exposes it.
   * Optional because a stand-in that only answers questions reports no policy.
   * @param session - the session whose own log supplies the override.
   * @returns `ask` or `never`, or `undefined` when the seam does not say.
   */
  effectivePolicy?(session: unknown): string | undefined
}

/** What the runtime contributes to a guard that remembers approvals. */
export interface ApprovalOptions {
  /** The approval seam, or a getter that answers `undefined` when there is none. */
  readonly approval: () => ApprovalService | undefined
  /** Where an approval is remembered. */
  readonly state: WorkflowState
  /** Whether the policy that owns this guard remembers approvals at all. */
  readonly remembers: () => boolean
}

/**
 * What makes two calls the same operation: one tool and one serialised
 * argument list. Not just the recognised operation — `git clean -f` and
 * `git clean -f -d` are different commands, and a grant for one is not a grant
 * for the other.
 * @param exec - the call the agent is about to make.
 * @returns the text the fingerprint is taken over.
 */
function operationOf(exec: ToolExecution): string {
  return `${exec.name} ${JSON.stringify(exec.arguments ?? null)}`
}

/**
 * Build the approver one remembering guard asks through.
 * @param options - the approval seam, the memory, and the policy switch.
 * @returns the approver `createGuard` consults for that guard.
 */
export function createGuardApprover(options: ApprovalOptions): GuardApprover {
  // An agent-less execution has no session to remember under, so nothing is ever
  // approved and `ask` leaves the question to the dispatcher.
  const sessionOf = (exec: ToolExecution): string | undefined => {
    const session = exec.agent?.session
    return session === undefined ? undefined : String(session.id)
  }

  return {
    remembers: () => options.remembers(),

    approved: (_hit, exec) => {
      const session = sessionOf(exec)
      if (session === undefined) return false
      return options.state.approved(session, fingerprint(operationOf(exec)))
    },

    remember: (_hit, exec) => {
      const session = sessionOf(exec)
      if (session === undefined) return
      options.state.rememberApproval(session, fingerprint(operationOf(exec)))
    },

    ask: async (hit, exec, t) => {
      const service = options.approval()
      // No seam, or nobody to route the question through: the dispatcher's own
      // prompt stands, which is exactly what the policy asks for when switched
      // off. Asking is never silently treated as approval.
      if (service === undefined || exec.agent === undefined) return decide(hit, t)

      // Under the `never` policy the question is refused before any answerer is
      // consulted (`dsh-user-approval/lib/index.js:175`), so asking would only
      // buy a round trip and a refusal misattributed to the user.
      const question = unaskable(decide(hit, t), t, () => service, exec.agent.session)
      if (question.kind !== 'ask') return question

      const outcome = await service.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: question.reason,
        ...(question.displayReason === undefined ? {} : { displayReason: question.displayReason }),
        signal: exec.signal,
      })

      switch (outcome) {
        case 'allowed-once':
          return undefined
        case 'rejected':
          return { kind: 'deny', reason: t('security.guard.approval_rejected') }
        case 'cancelled':
          return { kind: 'deny', reason: t('security.guard.approval_cancelled') }
        default:
          // `unavailable`, and anything a future seam might answer that this
          // plugin does not recognise: not a grant, so not a way through.
          return { kind: 'deny', reason: t('security.guard.approval_unavailable') }
      }
    },
  }
}
