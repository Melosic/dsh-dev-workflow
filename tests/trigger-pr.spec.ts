import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import {
  createPrePrTrigger,
  detectPullRequest,
  evaluatePullRequest,
} from '../src/triggers/pre-pr.js'
import { makeExec } from './harness.js'

const t = createTranslator('en-US')
const config = Config({})

/** A description that satisfies the template the specification ships. */
const GOOD_BODY = [
  '## What',
  '',
  'Add a `--json` flag to the status command.',
  '',
  '## Why',
  '',
  'Scripts cannot parse the current prose output. Closes #7.',
  '',
  '## How to verify',
  '',
  'Run `/dev-workflow status --json` and check that it parses.',
].join('\n')

/**
 * Build the listener the way the runtime does.
 * @param options - configuration overrides and the shared state to use.
 * @returns the listener, its state, and resolved configuration.
 */
function trigger(
  options: {
    config?: Record<string, unknown>
    state?: ReturnType<typeof createWorkflowState>
  } = {},
) {
  const state = options.state ?? createWorkflowState()
  const resolved = Config(options.config ?? {})
  const listener = createPrePrTrigger({
    config: () => resolved,
    t: () => t,
    state,
    log: () => {},
  })
  return { listener, state, config: resolved }
}

/** Run one shell command through the listener. */
async function fire(
  listener: ReturnType<typeof createPrePrTrigger>,
  command: string,
  options: {
    sessionId?: string
    cwd?: string
    withoutAgent?: boolean
    downstream?: PreToolDecision
    signal?: AbortSignal
  } = {},
): Promise<PreToolDecision> {
  return listener(
    makeExec(command, {
      sessionId: options.sessionId,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      withoutAgent: options.withoutAgent,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    async () => options.downstream ?? { kind: 'allow' },
  )
}

/**
 * Wrap a multi-line body the way a shell sees it.
 *
 * Single quotes, not `JSON.stringify`: the lexer resolves escapes, so a
 * double-quoted `\n` would reach the gate as a bare `n` and the sections would
 * all look empty.
 * @param body - the description text.
 * @returns the text as one single-quoted shell word.
 */
function quoted(body: string): string {
  return `'${body}'`
}

describe('src/triggers/pre-pr.ts', () => {
  it('recognises a pull request only when gh is asked to create one', () => {
    expect(detectPullRequest('gh pr create --title "feat(a): b" --body "x"')).toMatchObject({
      title: 'feat(a): b',
      body: 'x',
    })
    expect(detectPullRequest('gh pr create -t "feat(a): b" -F body.md')).toMatchObject({
      title: 'feat(a): b',
      bodyFile: 'body.md',
    })
    // `--title=` is the form an agent writes when it builds the line by hand.
    expect(detectPullRequest('gh pr create --title="feat(a): b"')).toMatchObject({
      title: 'feat(a): b',
    })

    for (const command of [
      'gh pr view 13',
      'gh pr merge 13 --squash',
      'gh pr list',
      'git commit -m "feat(a): b"',
      'echo "gh pr create"',
    ]) {
      expect(detectPullRequest(command), command).toBeUndefined()
    }
  })

  it('asks about a title that breaks the commit conventions', async () => {
    const { listener, state } = trigger()
    const decision = await fire(
      listener,
      `gh pr create --title "Add the flag" --body ${quoted(GOOD_BODY)}`,
    )

    expect(decision.kind).toBe('ask')
    // The title becomes the squash-merge commit on main, so it is judged by the
    // commit-message rules rather than by a separate set.
    expect((decision as { reason: string }).reason).toContain(
      t('tool.check_commit_message.error.missing_type'),
    )
    expect(state.lastOutcome()).toMatchObject({ kind: 'pr', ok: false })
  })

  it('asks about a description that leaves the template sections empty', async () => {
    const { listener } = trigger()
    const body = ['## What', '', 'Add a flag.', '', '## Why', '', '## How to verify', ''].join('\n')
    const decision = await fire(
      listener,
      `gh pr create --title "feat(cli): add a flag" --body ${quoted(body)}`,
    )

    expect(decision.kind).toBe('ask')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('Why')
    expect(reason).toContain('How to verify')
    expect(reason).not.toContain('What,')
  })

  it('asks about a description that omits the template altogether', async () => {
    const { listener } = trigger()
    const decision = await fire(
      listener,
      'gh pr create --title "feat(cli): add a flag" --body "Adds a flag."',
    )
    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain('What, Why, How to verify')
  })

  it('asks about a checklist left unticked', async () => {
    const { listener } = trigger()
    const body = `${GOOD_BODY}\n\n## Checklist\n\n- [x] Tests pass\n- [ ] Documentation updated\n`
    const decision = await fire(
      listener,
      `gh pr create --title "feat(cli): add a flag" --body ${quoted(body)}`,
    )
    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain(
      t('trigger.pre_pr.error.checklist', { count: 1 }),
    )
  })

  it('notes a missing issue reference without blocking on it', () => {
    const outcome = evaluatePullRequest(
      { title: 'feat(cli): add a flag', body: GOOD_BODY.replace(' Closes #7.', '') },
      config,
      t,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings).toContain(t('trigger.pre_pr.warn.issue'))
  })

  it('passes a compliant pull request without a word', async () => {
    const { listener, state } = trigger()
    const decision = await fire(
      listener,
      `gh pr create --title "feat(cli): add a json flag" --body ${quoted(GOOD_BODY)}`,
    )

    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toMatchObject({ kind: 'pr', ok: true })
  })

  it('reads a description given as a file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-pr-'))
    writeFileSync(join(directory, 'body.md'), GOOD_BODY, 'utf8')

    const { listener } = trigger()
    const compliant = await fire(
      listener,
      'gh pr create --title "feat(cli): add a json flag" -F body.md',
      { cwd: directory },
    )
    expect(compliant.kind).toBe('allow')

    writeFileSync(join(directory, 'thin.md'), 'Nothing here.', 'utf8')
    const thin = await fire(listener, 'gh pr create --title "feat(cli): add a flag" -F thin.md', {
      cwd: directory,
    })
    expect(thin.kind).toBe('ask')
    expect((thin as { reason: string }).reason).toContain('What, Why, How to verify')
  })

  it('renders the approval prompt in both client languages', async () => {
    const { listener } = trigger()
    const decision = await fire(listener, 'gh pr create --title "Add the flag"')
    const display = (decision as { displayReason: { en: string; zh: string } }).displayReason

    expect(display.en).toContain(createTranslator('en-US')('trigger.pre_pr.ask').split('\n')[0])
    expect(display.zh).toContain(createTranslator('zh-CN')('trigger.pre_pr.ask').split('\n')[0])
    expect(display.en).not.toContain('开发工作流插件发现')
    expect(display.zh).not.toContain('The development-workflow plugin found')
  })

  it('stays out of the way while the agent is only coding', async () => {
    const { listener, state } = trigger()
    for (const command of [
      'npm test',
      'git status',
      'git commit -m "feat(cli): add a flag"',
      'gh pr view 13',
      'gh issue list',
      'git push origin feature/x',
    ]) {
      expect((await fire(listener, command)).kind, command).toBe('allow')
    }
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('ignores a tool call that is not tied to an agent session', async () => {
    const { listener, state } = trigger()
    const decision = await fire(listener, 'gh pr create --title "Add the flag"', {
      withoutAgent: true,
    })
    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('never second-guesses a gate that already decided', async () => {
    const { listener } = trigger()
    const refusal = await fire(listener, 'gh pr create --title "Add the flag"', {
      downstream: { kind: 'deny', reason: 'another gate says no' },
    })
    expect(refusal).toEqual({ kind: 'deny', reason: 'another gate says no' })
  })

  it('reports an abort rather than a finding', async () => {
    const { listener, state } = trigger()
    const controller = new AbortController()
    controller.abort()
    const decision = await fire(listener, 'gh pr create --title "Add the flag"', {
      signal: controller.signal,
    })
    expect(decision).toEqual({ kind: 'cancel' })
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('prompts once per problem per session, so ignoring it is survivable', async () => {
    const { listener } = trigger()
    const command = 'gh pr create --title "Add the flag"'

    expect((await fire(listener, command)).kind).toBe('ask')
    expect((await fire(listener, command)).kind).toBe('allow')
  })

  it('prompts again for a different title in the same session', async () => {
    const { listener } = trigger()
    expect((await fire(listener, 'gh pr create --title "Add the flag"')).kind).toBe('ask')
    expect((await fire(listener, 'gh pr create --title "Add another flag"')).kind).toBe('ask')
  })

  it('prompts again in a different session', async () => {
    const state = createWorkflowState()
    const { listener } = trigger({ state })
    const command = 'gh pr create --title "Add the flag"'

    expect((await fire(listener, command, { sessionId: 'session-1' })).kind).toBe('ask')
    expect((await fire(listener, command, { sessionId: 'session-2' })).kind).toBe('ask')
  })
})
