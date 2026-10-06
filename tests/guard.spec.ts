import { describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import { createGitGuard, detectGuard } from '../src/guard/git-guard.js'
import { allow, makeExec } from './harness.js'

const t = createTranslator('en-US')
const config = Config({})

/**
 * Classify one command the way the live gate does.
 * @param command - the shell command line.
 * @param overrides - configuration overrides, e.g. `{ forcePush: 'deny' }`.
 * @returns the reason and action of the strictest hit, or `undefined`.
 */
function classify(command: string, overrides: Record<string, string> = {}) {
  const hit = detectGuard(command, Config({ gitGuard: overrides }))
  return hit === undefined ? undefined : { reason: hit.reason, action: hit.action }
}

/**
 * Run one command through the listener and report the decision it settles on.
 * @param command - the shell command line.
 * @param options - configuration overrides and a downstream decision to model.
 * @returns the decision, plus the guard tally it produced.
 */
async function run(
  command: string,
  options: {
    overrides?: Record<string, string>
    downstream?: PreToolDecision
    state?: ReturnType<typeof createWorkflowState>
    aborted?: boolean
  } = {},
) {
  const state = options.state ?? createWorkflowState()
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()
  const guard = createGitGuard({
    config: () => Config({ gitGuard: options.overrides ?? {} }),
    t: () => t,
    state,
    log: () => {},
  })
  const decision = await guard(
    makeExec(command, { signal: controller.signal }),
    async () => options.downstream ?? (await allow()),
  )
  return { decision, state }
}

describe('src/guard/git-guard.ts', () => {
  it('denies a force push when configured to deny', async () => {
    const { decision } = await run('git push --force origin main', {
      overrides: { forcePush: 'deny' },
    })
    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toBe(
      `${t('security.guard.force_push')}\n${t('security.guard.suggest_force_with_lease')}`,
    )
  })

  it('asks about a bare --force by default, in both client languages', async () => {
    const { decision } = await run('git push --force origin main')
    expect(decision.kind).toBe('ask')
    expect(decision).toMatchObject({
      reason: `${t('security.guard.force_push')}\n${t('security.guard.suggest_force_with_lease')}`,
      displayReason: {
        en: `${createTranslator('en-US')('security.guard.force_push')}\n${createTranslator('en-US')('security.guard.suggest_force_with_lease')}`,
        zh: `${createTranslator('zh-CN')('security.guard.force_push')}\n${createTranslator('zh-CN')('security.guard.suggest_force_with_lease')}`,
      },
    })
  })

  it('lets --force-with-lease through without asking', async () => {
    expect(classify('git push --force-with-lease=main origin main')).toBeUndefined()
    expect(classify('git push --force-with-lease origin main')).toBeUndefined()
    const { decision, state } = await run('git push --force-with-lease origin main')
    expect(decision.kind).toBe('allow')
    expect(state.guardHits()).toEqual({})
  })

  it('still sees a forced push when --force rides along with --force-with-lease', () => {
    // `--force` overrides the lease, so the pair really does clobber the remote.
    expect(classify('git push --force-with-lease --force origin main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
    expect(classify('git push --force --force-with-lease origin main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
    expect(classify('git push -f --force-with-lease origin main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
    expect(classify('git push --force-with-lease=origin/main origin +main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
  })

  it('sees the git command through a wrapper in front of it', () => {
    expect(classify('sudo git push --force origin main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
    expect(classify('FOO=1 sudo git reset --hard HEAD~1')).toMatchObject({
      reason: 'security.guard.hard_reset',
    })
  })

  it('sees a forced push through a short option and a leading plus refspec', () => {
    expect(classify('git push -f origin main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
    expect(classify('git push origin +main')).toMatchObject({
      reason: 'security.guard.force_push',
    })
  })

  it('leaves an ordinary push alone', () => {
    expect(classify('git push origin main')).toBeUndefined()
    expect(classify('git push')).toBeUndefined()
  })

  it('denies a hard reset when configured to deny, and asks by default', async () => {
    expect(classify('git reset --hard HEAD~1')).toMatchObject({
      reason: 'security.guard.hard_reset',
      action: 'ask',
    })
    const { decision } = await run('git reset --hard HEAD~1', { overrides: { hardReset: 'deny' } })
    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toBe(t('security.guard.hard_reset'))
  })

  it('leaves a soft or mixed reset alone', () => {
    expect(classify('git reset --soft HEAD~1')).toBeUndefined()
    expect(classify('git reset HEAD~1')).toBeUndefined()
  })

  it('asks about --no-verify before it runs the hooks', async () => {
    const { decision } = await run('git commit --no-verify -m "chore: tidy"')
    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toBe(t('security.guard.no_verify'))
  })

  it('asks about a rebase by default', async () => {
    const { decision } = await run('git rebase --onto main dev topic')
    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toBe(t('security.guard.rebase'))
  })

  it('asks about the other destructive operations it knows', () => {
    expect(classify('git clean -fd')).toMatchObject({ reason: 'security.guard.clean_force' })
    expect(classify('git clean --force')).toMatchObject({ reason: 'security.guard.clean_force' })
    expect(classify('git commit --amend --no-edit')).toMatchObject({
      reason: 'security.guard.amend',
    })
    expect(classify('git branch -D topic')).toMatchObject({
      reason: 'security.guard.branch_delete',
    })
    expect(classify('git branch --delete --force topic')).toMatchObject({
      reason: 'security.guard.branch_delete',
    })
    expect(classify('git checkout -- src/a.ts')).toMatchObject({
      reason: 'security.guard.checkout_discard',
    })
  })

  it('leaves the harmless neighbours of those operations alone', () => {
    expect(classify('git clean -n')).toBeUndefined()
    expect(classify('git clean -d')).toBeUndefined()
    expect(classify('git branch -d topic')).toBeUndefined()
    expect(classify('git branch --delete topic')).toBeUndefined()
    expect(classify('git checkout main')).toBeUndefined()
    expect(classify('git checkout --')).toBeUndefined()
    expect(classify('echo "git reset --hard"')).toBeUndefined()
    expect(classify('git status --porcelain')).toBeUndefined()
  })

  it('honours all three policy values for one operation', async () => {
    const deny = await run('git rebase main', { overrides: { rebase: 'deny' } })
    expect(deny.decision.kind).toBe('deny')

    const ask = await run('git rebase main', { overrides: { rebase: 'ask' } })
    expect(ask.decision.kind).toBe('ask')

    const allowed = await run('git rebase main', { overrides: { rebase: 'allow' } })
    expect(allowed.decision.kind).toBe('allow')
    expect(allowed.state.guardHits()).toEqual({})
  })

  it('counts a hit before the decision is settled', async () => {
    const { state } = await run('git push --force origin main')
    expect(state.guardHits()).toEqual({ 'security.guard.force_push': 1 })
  })

  it('never weakens another gate refusal or an abort', async () => {
    const refusal = await run('git push --force origin main', {
      downstream: { kind: 'deny', reason: 'another gate says no' },
    })
    expect(refusal.decision).toEqual({ kind: 'deny', reason: 'another gate says no' })

    const cancelled = await run('git rebase main', { downstream: { kind: 'cancel' } })
    expect(cancelled.decision).toEqual({ kind: 'cancel' })

    const aborted = await run('git rebase main', { aborted: true })
    expect(aborted.decision).toEqual({ kind: 'cancel' })
  })

  it('lets its own deny stand even when the rest of the chain would allow', async () => {
    const { decision } = await run('git push --force origin main', {
      overrides: { forcePush: 'deny' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('replaces another gate ask with its own reason, at deny severity', async () => {
    // A conflicting gate already asked; the guard's question names the operation
    // that actually discards work, and its denied tier outranks the question.
    const { decision } = await run('git reset --hard', {
      overrides: { hardReset: 'deny' },
      downstream: { kind: 'ask', reason: 'another gate asks' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('reports the strictest hit when one command does several things', () => {
    // `--no-verify` defaults to ask and the force push to deny.
    expect(
      classify('git push --no-verify --force origin main', { forcePush: 'deny' }),
    ).toMatchObject({ reason: 'security.guard.force_push', action: 'deny' })
    // A tie keeps the operation rather than the modifier.
    expect(classify('git push --no-verify --force origin main')).toMatchObject({
      reason: 'security.guard.force_push',
      action: 'ask',
    })
  })

  it('does nothing while the guard is disabled', async () => {
    const state = createWorkflowState()
    const guard = createGitGuard({
      config: () => Config({ gitGuard: { enabled: false } }),
      t: () => t,
      state,
      log: () => {},
    })
    const decision = await guard(makeExec('git push --force origin main'), allow)
    expect(decision.kind).toBe('allow')
    expect(state.guardHits()).toEqual({})
  })

  it('ignores a tool call that runs no shell command', async () => {
    const state = createWorkflowState()
    const guard = createGitGuard({ config: () => config, t: () => t, state, log: () => {} })
    const decision = await guard(
      { callId: 'c', name: 'read', arguments: {}, signal: new AbortController().signal } as never,
      allow,
    )
    expect(decision.kind).toBe('allow')
    expect(state.guardHits()).toEqual({})
  })
})
