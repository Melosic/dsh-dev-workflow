import { describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import type { GitRunner } from '../src/git.js'
import { createRuntime } from '../src/index.js'
import { createPreCommitTrigger } from '../src/triggers/pre-commit.js'
import { checkDocSync } from '../src/tools/check-doc-sync.js'
import { createHarness, makeExec, makeGit } from './harness.js'

const t = createTranslator('en-US')

/**
 * Build the listener the way the runtime does, with a working tree the spec owns.
 * @param options - configuration overrides and the changed paths to report.
 * @returns the listener, its state, and the paths it reads on every call.
 */
function trigger(
  options: {
    config?: Record<string, unknown>
    files?: () => readonly string[]
    state?: ReturnType<typeof createWorkflowState>
    policy?: string
  } = {},
) {
  const state = options.state ?? createWorkflowState()
  const resolved = Config(options.config ?? {})
  const git: GitRunner = makeGit(options.files ?? (() => []))
  const listener = createPreCommitTrigger({
    config: () => resolved,
    t: () => t,
    state,
    git: () => git,
    log: () => {},
    ...(options.policy === undefined
      ? {}
      : { approval: () => ({ effectivePolicy: () => options.policy }) }),
  })
  return { listener, state, config: resolved }
}

/** Run one shell command through the listener. */
async function fire(
  listener: ReturnType<typeof createPreCommitTrigger>,
  command: string,
  options: {
    sessionId?: string
    withoutAgent?: boolean
    downstream?: PreToolDecision
    signal?: AbortSignal
  } = {},
): Promise<PreToolDecision> {
  return listener(
    makeExec(command, {
      sessionId: options.sessionId,
      withoutAgent: options.withoutAgent,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    async () => options.downstream ?? { kind: 'allow' },
  )
}

describe('src/triggers/pre-commit.ts', () => {
  it('asks about a commit whose message breaks the conventions', async () => {
    const { listener } = trigger()
    const decision = await fire(listener, 'git commit -m "Add the thing"')

    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain(
      t('tool.check_commit_message.error.missing_type'),
    )
  })

  it('renders the approval prompt in both client languages', async () => {
    const { listener } = trigger()
    const decision = await fire(listener, 'git commit -m "Add the thing"')
    const display = (decision as { displayReason: { en: string; zh: string } }).displayReason

    expect(display.en).toContain(
      createTranslator('en-US')('tool.check_commit_message.error.missing_type'),
    )
    expect(display.zh).toContain(
      createTranslator('zh-CN')('tool.check_commit_message.error.missing_type'),
    )
    expect(display.en).not.toContain('提交信息缺少类型前缀')
    expect(display.zh).not.toContain('has no type prefix')
    // Both sides are complete prompts, not just translated findings.
    expect(display.en).toContain('Approve to commit anyway')
    expect(display.zh).toContain('批准则照常提交')
    expect(display.en).not.toBe(display.zh)
  })

  it('passes a compliant commit without a word', async () => {
    const { listener, state } = trigger()
    const decision = await fire(listener, 'git commit -m "fix(cli): stop crashing"')

    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toMatchObject({ kind: 'commit', ok: true })
  })

  it('refuses a finding in its own words when the session cannot be asked', async () => {
    // Under the `never` policy a returned `ask` is refused without a prompt and
    // reported as the user's refusal, so the finding is refused here instead.
    const { listener } = trigger({ policy: 'never' })
    const decision = await fire(listener, 'git commit -m "Add the thing"')

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain(
      t('tool.check_commit_message.error.missing_type'),
    )
    expect(decision.kind === 'deny' && decision.reason).toContain(t('approval.disabled'))
  })

  it('stays out of the way while the agent is only coding', async () => {
    const { listener, state } = trigger()
    for (const command of ['npm test', 'git status', 'git add -A', 'echo hi']) {
      expect((await fire(listener, command)).kind, command).toBe('allow')
    }
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('ignores a tool call that is not tied to an agent session', async () => {
    const { listener, state } = trigger()
    const decision = await fire(listener, 'git commit -m "Add the thing"', { withoutAgent: true })
    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('never second-guesses a gate that already decided', async () => {
    const { listener } = trigger()
    const refusal = await fire(listener, 'git commit -m "Add the thing"', {
      downstream: { kind: 'deny', reason: 'another gate says no' },
    })
    expect(refusal).toEqual({ kind: 'deny', reason: 'another gate says no' })

    const question = await fire(listener, 'git commit -m "Add the thing"', {
      downstream: { kind: 'ask', reason: 'another gate asks' },
    })
    expect(question).toEqual({ kind: 'ask', reason: 'another gate asks' })
  })

  it('reports an abort rather than a finding', async () => {
    const { listener, state } = trigger()
    const controller = new AbortController()
    controller.abort()
    const decision = await fire(listener, 'git commit -m "Add the thing"', {
      signal: controller.signal,
    })
    expect(decision).toEqual({ kind: 'cancel' })
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('does not block a code change that only skipped its documentation', async () => {
    // Missing docs and a missing CHANGELOG entry are advisories, not blockers:
    // `docs/TRIGGERS.md` documents that a change like this warns and proceeds.
    // The advisory itself is asserted where it is produced.
    expect(checkDocSync({ files: ['src/a.ts'] }, Config({}), t).warnings).not.toEqual([])

    const { listener, state } = trigger({ files: () => ['src/a.ts'] })
    const decision = await fire(listener, 'git commit -m "chore(cli): tidy"')
    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toMatchObject({ kind: 'commit', ok: true })
  })

  it('prompts when a feature adds no changelog entry', async () => {
    const { listener } = trigger({ files: () => ['src/a.ts'] })
    const decision = await fire(listener, 'git commit -m "feat(cli): add a flag"')
    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain(
      t('tool.check_commit_message.error.changelog_required', { changelog: 'CHANGELOG.md' }),
    )
  })

  it('prompts once per problem per session, so ignoring it is survivable', async () => {
    const { listener } = trigger()
    const command = 'git commit -m "Add the thing"'

    expect((await fire(listener, command)).kind).toBe('ask')
    // The agent ignores the prompt and re-runs the identical command.
    expect((await fire(listener, command)).kind).toBe('allow')
  })

  it('prompts again for a different problem in the same session', async () => {
    const { listener } = trigger()

    expect((await fire(listener, 'git commit -m "Add the thing"')).kind).toBe('ask')
    expect((await fire(listener, 'git commit -m "Add another thing"')).kind).toBe('ask')
  })

  it('prompts again in a different session', async () => {
    const state = createWorkflowState()
    const { listener } = trigger({ state })
    const command = 'git commit -m "Add the thing"'

    expect((await fire(listener, command, { sessionId: 'session-1' })).kind).toBe('ask')
    expect((await fire(listener, command, { sessionId: 'session-2' })).kind).toBe('ask')
  })

  it('treats the same commit with a different working tree as a new problem', async () => {
    const files = ['src/a.ts']
    const { listener } = trigger({ files: () => files })
    const command = 'git commit -m "feat(cli): add a flag"'

    expect((await fire(listener, command)).kind).toBe('ask')
    expect((await fire(listener, command)).kind).toBe('allow')

    // A different change set is a different target, so it is checked afresh.
    files.push('src/b.ts')
    expect((await fire(listener, command)).kind).toBe('ask')
  })

  it('does not fire while the mode is off or the trigger is disabled', async () => {
    // The two switches are independent: `mode: off` registers nothing at all,
    // while `enableOwnTrigger: false` keeps the guards and drops only this
    // listener. Both are asserted through the registrations the runtime makes,
    // then by running whatever was registered against a non-compliant commit.
    const off = createHarness()
    createRuntime(off.ctx, Config({ mode: 'off' }))
    expect(off.listeners).toHaveLength(0)
    expect(await chain(off.listeners, 'git commit -m "Add the thing"')).toEqual({ kind: 'allow' })

    const withoutTrigger = createHarness()
    createRuntime(withoutTrigger.ctx, Config({ enableOwnTrigger: false }))
    // `enableOwnTrigger: false` drops all three convention triggers — commit,
    // pull request, and release — and keeps the five guards: git, outward,
    // command, file, secret.
    expect(withoutTrigger.listeners).toHaveLength(5)
    expect(await chain(withoutTrigger.listeners, 'git commit -m "Add the thing"')).toEqual({
      kind: 'allow',
    })
  })
})

/**
 * Run a command through a registered listener chain, outermost first.
 * @param listeners - the listeners the runtime registered, in order.
 * @param command - the shell command line the agent is about to run.
 * @returns the decision the chain settles on.
 */
async function chain(
  listeners: readonly { listener: (exec: never, next: never) => Promise<PreToolDecision> }[],
  command: string,
): Promise<PreToolDecision> {
  const exec = makeExec(command)
  let index = -1
  const step = async (): Promise<PreToolDecision> => {
    index += 1
    const next = listeners[index]
    if (next === undefined) return { kind: 'allow' }
    return next.listener(exec as never, (() => step()) as never)
  }
  return step()
}
