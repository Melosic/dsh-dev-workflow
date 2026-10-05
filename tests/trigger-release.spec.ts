import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import {
  createPreReleaseTrigger,
  detectRelease,
  evaluateRelease,
} from '../src/triggers/pre-release.js'
import { makeExec } from './harness.js'

const t = createTranslator('en-US')

/** A changelog with entries waiting under `[Unreleased]`. */
const FULL_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- A `--json` flag for the status command.',
  '',
  '## [0.1.0] - 2026-01-01',
  '',
  '### Added',
  '',
  '- The first release.',
  '',
].join('\n')

/** A changelog whose `[Unreleased]` section is present but empty. */
const EMPTY_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [0.1.0] - 2026-01-01',
  '',
].join('\n')

/**
 * Write a throwaway project with a `package.json` and a changelog.
 * @param version - the version to record in the manifest.
 * @param changelog - the changelog text, when the release should have one.
 * @returns the directory, for use as a session working directory.
 */
function project(version: string, changelog?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }), 'utf8')
  if (changelog !== undefined) writeFileSync(join(directory, 'CHANGELOG.md'), changelog, 'utf8')
  return directory
}

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
  const listener = createPreReleaseTrigger({
    config: () => resolved,
    t: () => t,
    state,
    log: () => {},
  })
  return { listener, state, config: resolved }
}

/** Run one shell command through the listener. */
async function fire(
  listener: ReturnType<typeof createPreReleaseTrigger>,
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

describe('src/triggers/pre-release.ts', () => {
  it('recognises a tag or a publish and nothing else', () => {
    expect(detectRelease('git tag v0.2.0')).toEqual({ tag: 'v0.2.0' })
    expect(detectRelease('git tag -a v0.2.0 -m "release"')).toEqual({ tag: 'v0.2.0' })
    expect(detectRelease('git tag -m "release" v0.2.0')).toEqual({ tag: 'v0.2.0' })
    expect(detectRelease('npm publish')).toEqual({ publishTag: 'latest' })
    expect(detectRelease('npm publish --tag next')).toEqual({ publishTag: 'next' })
    expect(detectRelease('npm publish --tag=next')).toEqual({ publishTag: 'next' })
    // One line can do both, and the checks need to see both to judge it.
    expect(detectRelease('git tag v0.2.0 && npm publish')).toEqual({
      tag: 'v0.2.0',
      publishTag: 'latest',
    })

    for (const command of [
      'git tag',
      'git tag --list',
      'git tag -l "v*"',
      'git tag -d v0.1.0',
      'git tag -v v0.1.0',
      'git push origin v0.1.0',
      'npm test',
      'npm run build',
      'npm install',
      'echo "npm publish"',
    ]) {
      expect(detectRelease(command), command).toBeUndefined()
    }
  })

  it('asks when the unreleased section holds nothing', async () => {
    const { listener, state } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const decision = await fire(listener, 'git tag v0.2.0', { cwd: directory })

    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain(
      t('trigger.pre_release.error.changelog_empty', { version: '0.2.0' }),
    )
    expect(state.lastOutcome()).toMatchObject({ kind: 'release', ok: false })
  })

  it('asks when the tag and the manifest name different versions', async () => {
    const { listener } = trigger()
    const directory = project('0.1.0', FULL_CHANGELOG)
    const decision = await fire(listener, 'git tag v0.2.0', { cwd: directory })

    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain(
      t('trigger.pre_release.error.version_mismatch', { tag: '0.2.0', version: '0.1.0' }),
    )
  })

  it('asks when a pre-release is published to latest', async () => {
    const { listener } = trigger()
    // `npm publish` states no dist-tag, and npm defaults pre-releases to
    // `latest` as readily as anything else — which is exactly the mistake.
    const directory = project('0.2.0-rc.1', FULL_CHANGELOG)
    const decision = await fire(listener, 'npm publish', { cwd: directory })

    expect(decision.kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain(
      t('trigger.pre_release.error.prerelease_tag', { version: '0.2.0-rc.1' }),
    )
  })

  it('accepts a pre-release published to its own dist-tag', async () => {
    const { listener, state } = trigger()
    const directory = project('0.2.0-rc.1', FULL_CHANGELOG)
    const decision = await fire(listener, 'git tag v0.2.0-rc.1 && npm publish --tag next', {
      cwd: directory,
    })

    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toMatchObject({ kind: 'release', ok: true })
  })

  it('asks about a version that is not a semantic version', () => {
    const outcome = evaluateRelease({ version: '0.2' }, t)
    expect(outcome.ok).toBe(false)
    expect(outcome.errors).toContain(t('trigger.pre_release.error.version', { version: '0.2' }))
  })

  it('asks about a changelog category Keep a Changelog does not define', () => {
    const changelog = FULL_CHANGELOG.replace('### Added', '### Improvements')
    const outcome = evaluateRelease({ version: '0.2.0', changelog }, t)
    expect(outcome.errors).toContain(
      t('trigger.pre_release.error.changelog_category', { section: 'Improvements' }),
    )
  })

  it('asks when the changelog keeps no unreleased section at all', () => {
    const outcome = evaluateRelease({ version: '0.2.0', changelog: '# Changelog\n' }, t)
    expect(outcome.errors).toContain(t('trigger.pre_release.error.changelog'))
  })

  it('passes a compliant release without a word', async () => {
    const { listener, state } = trigger()
    const directory = project('0.2.0', FULL_CHANGELOG)
    const decision = await fire(listener, 'git tag v0.2.0', { cwd: directory })

    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toMatchObject({ kind: 'release', ok: true })
  })

  it('accepts entries already moved into the version section', async () => {
    // The release procedure moves the entries out of `[Unreleased]` and into
    // `[<version>]` before tagging, so a changelog in that state is complete.
    const moved = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [0.2.0]',
      '',
      '### Added',
      '',
      '- A flag.',
    ].join('\n')
    const outcome = evaluateRelease({ version: '0.2.0', changelog: moved }, t)
    expect(outcome.errors).toEqual([])
  })

  it('renders the approval prompt in both client languages', async () => {
    const { listener } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const decision = await fire(listener, 'git tag v0.2.0', { cwd: directory })
    const display = (decision as { displayReason: { en: string; zh: string } }).displayReason

    expect(display.en).toContain(
      createTranslator('en-US')('trigger.pre_release.ask').split('\n')[0],
    )
    expect(display.zh).toContain(
      createTranslator('zh-CN')('trigger.pre_release.ask').split('\n')[0],
    )
    expect(display.en).not.toContain('开发工作流插件发现')
    expect(display.zh).not.toContain('The development-workflow plugin found')
  })

  it('stays out of the way while the agent is only coding', async () => {
    const { listener, state } = trigger()
    const directory = project('0.1.0', FULL_CHANGELOG)
    for (const command of [
      'npm test',
      'npm run build',
      'git status',
      'git commit -m "feat(cli): add a flag"',
      'git push origin main',
      'git tag --list',
    ]) {
      expect((await fire(listener, command, { cwd: directory })).kind, command).toBe('allow')
    }
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('ignores a tool call that is not tied to an agent session', async () => {
    const { listener, state } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const decision = await fire(listener, 'npm publish', { cwd: directory, withoutAgent: true })
    expect(decision.kind).toBe('allow')
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('never second-guesses a gate that already decided', async () => {
    const { listener } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const refusal = await fire(listener, 'npm publish', {
      cwd: directory,
      downstream: { kind: 'deny', reason: 'another gate says no' },
    })
    expect(refusal).toEqual({ kind: 'deny', reason: 'another gate says no' })
  })

  it('reports an abort rather than a finding', async () => {
    const { listener, state } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const controller = new AbortController()
    controller.abort()
    const decision = await fire(listener, 'npm publish', {
      cwd: directory,
      signal: controller.signal,
    })
    expect(decision).toEqual({ kind: 'cancel' })
    expect(state.lastOutcome()).toBeUndefined()
  })

  it('prompts once per version per session, so ignoring it is survivable', async () => {
    const { listener } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const command = 'git tag v0.2.0'

    expect((await fire(listener, command, { cwd: directory })).kind).toBe('ask')
    expect((await fire(listener, command, { cwd: directory })).kind).toBe('allow')
  })

  it('prompts again for a different version in the same session', async () => {
    const { listener } = trigger()
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    expect((await fire(listener, 'git tag v0.2.0', { cwd: directory })).kind).toBe('ask')
    expect((await fire(listener, 'git tag v0.3.0', { cwd: directory })).kind).toBe('ask')
  })

  it('prompts again in a different session', async () => {
    const state = createWorkflowState()
    const { listener } = trigger({ state })
    const directory = project('0.1.0', EMPTY_CHANGELOG)
    const command = 'git tag v0.2.0'

    expect((await fire(listener, command, { cwd: directory, sessionId: 's1' })).kind).toBe('ask')
    expect((await fire(listener, command, { cwd: directory, sessionId: 's2' })).kind).toBe('ask')
  })

  it('checks a release even where there is no changelog to read', async () => {
    // Without a changelog the rules that need one simply do not run; the rules
    // that only need the version still do, so the gate never becomes a no-op.
    const directory = project('0.1.0')
    const { listener } = trigger()
    const decision = await fire(listener, 'git tag v0.2.0', { cwd: directory })
    expect(decision.kind).toBe('ask')
  })
})
