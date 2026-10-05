import { describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import type { WorkflowState } from '../src/state.js'
import { createGitGuard } from '../src/guard/git-guard.js'
import type { ApprovalOutcome, ApprovalRequest, ApprovalService } from '../src/guard/approval.js'
import { allow, makeExec } from './harness.js'

// `gitGuard.rememberApproved`: the one policy whose answer the guard has to read
// itself. The dispatcher asks on a guard's behalf and keeps the outcome, so a
// remembering guard asks through the approval seam directly — and these are the
// checks that it stays fail-closed while doing it.

const t = createTranslator('en-US')

/** A question the guard asked, as the answerer received it. */
type Asked = ApprovalRequest

/**
 * An approval seam that answers from a queue, so a spec states what the user
 * would have said.
 * @param answers - one outcome per question, in order.
 * @param sink - where to record questions, when a spec runs several calls.
 * @returns the seam and the questions it was asked.
 */
function makeApproval(
  answers: ApprovalOutcome[],
  sink: Asked[] = [],
): { approval: () => ApprovalService; asked: Asked[] } {
  const asked: Asked[] = sink
  return {
    asked,
    approval: () => ({
      request: async (request: ApprovalRequest) => {
        asked.push(request)
        return answers.shift() ?? 'unavailable'
      },
    }),
  }
}

/**
 * Run one command through the guard.
 * @param command - the shell command line.
 * @param options - policy overrides, answers, and the state to reuse.
 * @returns the decision, the seam's questions, and the guard tally.
 */
async function run(
  command: string,
  options: {
    overrides?: Record<string, unknown>
    remember?: boolean
    answers?: ApprovalOutcome[]
    state?: WorkflowState
    sessionId?: string
    arguments?: unknown
    downstream?: PreToolDecision
    withoutAgent?: boolean
    approval?: () => ApprovalService | undefined
    asked?: Asked[]
  } = {},
) {
  const state = options.state ?? createWorkflowState()
  const seam = makeApproval(options.answers ?? [], options.asked)
  const asked = seam.asked
  const audit: string[] = []
  const guard = createGitGuard({
    config: () =>
      Config({
        gitGuard: { rememberApproved: options.remember === true, ...options.overrides },
      }),
    t: () => t,
    state,
    log: () => {},
    audit: (hit) => audit.push(hit.reason),
    approval: options.approval ?? seam.approval,
  })
  const decision = await guard(
    makeExec(command, {
      sessionId: options.sessionId,
      arguments: options.arguments,
      withoutAgent: options.withoutAgent,
    }),
    async () => options.downstream ?? (await allow()),
  )
  return { decision, asked, audit, state }
}

describe('src/guard/approval.ts', () => {
  it('leaves the question to the dispatcher while the policy is off', async () => {
    const { decision, asked } = await run('git push --force origin main')

    expect(decision.kind).toBe('ask')
    expect(asked).toEqual([])
  })

  it('asks through the seam itself and lets the call through when approved', async () => {
    const { decision, asked } = await run('git push --force origin main', {
      remember: true,
      answers: ['allowed-once'],
    })

    expect(decision).toEqual({ kind: 'allow' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      toolName: 'bash',
      callId: 'call-1',
      reason: `${t('security.guard.force_push')}\n${t('security.guard.suggest_force_with_lease')}`,
      displayReason: {
        en: `${createTranslator('en-US')('security.guard.force_push')}\n${createTranslator('en-US')('security.guard.suggest_force_with_lease')}`,
        zh: `${createTranslator('zh-CN')('security.guard.force_push')}\n${createTranslator('zh-CN')('security.guard.suggest_force_with_lease')}`,
      },
    })
  })

  it('stops asking about the same operation for the rest of the session', async () => {
    const state = createWorkflowState()
    const first = await run('git push --force origin main', {
      remember: true,
      answers: ['allowed-once'],
      state,
    })

    expect(first.decision).toEqual({ kind: 'allow' })
    expect(first.asked).toHaveLength(1)

    const second = await run('git push --force origin main', {
      remember: true,
      state,
      // No answer queued: a second question would resolve `unavailable` and deny.
    })

    expect(second.decision).toEqual({ kind: 'allow' })
    // The second call produced a decision without asking anything.
    expect(second.asked).toEqual([])
    expect(second.state.guardHits()['security.guard.force_push']).toBe(2)
  })

  it('asks again for a different command, working directory, or session', async () => {
    const state = createWorkflowState()
    const { asked } = await run('git clean -f', {
      remember: true,
      answers: ['allowed-once'],
      state,
    })

    const other = await run('git clean -f -d', {
      remember: true,
      answers: ['allowed-once'],
      state,
      asked,
    })
    const elsewhere = await run('git clean -f', {
      remember: true,
      answers: ['allowed-once'],
      state,
      asked,
      arguments: { command: 'git clean -f', workdir: 'D:\\other' },
    })
    const otherSession = await run('git clean -f', {
      remember: true,
      answers: ['allowed-once'],
      state,
      asked,
      sessionId: 'session-2',
    })

    expect(other.decision).toEqual({ kind: 'allow' })
    expect(elsewhere.decision).toEqual({ kind: 'allow' })
    expect(otherSession.decision).toEqual({ kind: 'allow' })
    expect(asked).toHaveLength(4)
  })

  it('refuses for the session when the user rejects the question', async () => {
    const state = createWorkflowState()
    const refused = await run('git push --force origin main', {
      remember: true,
      answers: ['rejected'],
      state,
    })

    expect(refused.decision).toEqual({
      kind: 'deny',
      reason: t('security.guard.approval_rejected'),
    })

    // A refusal is not remembered as a grant: the next attempt asks again.
    const again = await run('git push --force origin main', {
      remember: true,
      answers: ['allowed-once'],
      state,
    })

    expect(again.decision).toEqual({ kind: 'allow' })
    expect(again.asked).toHaveLength(1)
  })

  it.each([
    ['cancelled', 'security.guard.approval_cancelled'],
    ['unavailable', 'security.guard.approval_unavailable'],
  ] as const)('treats %s as a refusal', async (outcome, key) => {
    const state = createWorkflowState()
    const { decision, asked } = await run('git push --force origin main', {
      remember: true,
      answers: [outcome],
      state,
    })

    expect(decision).toEqual({ kind: 'deny', reason: t(key) })

    // Nothing was granted, so the next attempt is asked about again.
    const again = await run('git push --force origin main', {
      remember: true,
      answers: ['allowed-once'],
      state,
      asked,
    })

    expect(again.decision).toEqual({ kind: 'allow' })
    expect(asked).toHaveLength(2)
  })

  it('never asks about a policy that denies', async () => {
    const { decision, asked } = await run('git push --force origin main', {
      remember: true,
      overrides: { forcePush: 'deny' },
    })

    expect(decision).toEqual({
      kind: 'deny',
      reason: `${t('security.guard.force_push')}\n${t('security.guard.suggest_force_with_lease')}`,
    })
    expect(asked).toEqual([])
  })

  it('falls back to the dispatcher when no approval service is composed', async () => {
    const { decision, asked, audit } = await run('git push --force origin main', {
      remember: true,
      approval: () => undefined,
    })

    expect(decision.kind).toBe('ask')
    expect(asked).toEqual([])
    expect(audit).toEqual(['security.guard.force_push'])
  })

  it('asks nothing without an agent to route the question through', async () => {
    const { decision, asked } = await run('git push --force origin main', {
      remember: true,
      withoutAgent: true,
    })

    expect(decision.kind).toBe('ask')
    expect(asked).toEqual([])
  })

  it('leaves another gate its own refusal and question', async () => {
    const denied = await run('git push --force origin main', {
      remember: true,
      downstream: { kind: 'deny', reason: 'another gate said no' },
    })
    const asked = await run('git push --force origin main', {
      remember: true,
      downstream: { kind: 'ask', reason: 'another gate wants to ask' },
    })

    expect(denied.decision).toEqual({ kind: 'deny', reason: 'another gate said no' })
    expect(denied.asked).toEqual([])
    // The guard's own question still replaces the other gate's, which is what
    // happens with the policy off; only the remembering is skipped, because
    // another gate's answer is not this guard's to remember.
    expect(asked.decision.kind).toBe('ask')
    expect(asked.asked).toEqual([])
  })
})
