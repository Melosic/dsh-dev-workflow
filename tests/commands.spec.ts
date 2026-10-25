import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { createRuntime } from '../src/index.js'
import { SCOPE_MARKER } from '../src/scope.js'
import { createHarness } from './harness.js'

// `/dev-workflow` is the door a user reaches this plugin through, and it is the
// only door: `off` unlocks it by withdrawing every other registration, so the
// command has to survive its own decision. Three properties are asserted here,
// each one a bug this file would have caught:
//
//   1. `off` leaves the command registered — otherwise there is no way back.
//   2. An unrelated settings write does not undo a manual `off` — the resync
//      compares signatures, and `off` clears the one it compares against.
//   3. `status` says *which* kind of off it is, because "off because the config
//      says so" and "off because you asked" answer differently to `/dev-workflow on`.
//
// A fourth property joined them with `scope`: the status is what a bug report
// quotes, so it has to name the scope and, for a marked-only configuration, the
// path of the marker — otherwise the commonest report cannot be diagnosed.

/** Throwaway repositories the scope case builds. */
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * The invocation slice the handler reads.
 * @param cwd - the working directory the session reports.
 * @returns a command invocation for one session and working directory.
 */
function invocation(cwd: string = process.cwd()) {
  return {
    agent: { session: { id: { toString: () => 'session-1' }, header: { cwd } } },
    rawInput: '',
    signal: new AbortController().signal,
  }
}

/**
 * Write one configuration leaf the way the panel's loader does.
 *
 * The volatile references are what the settings controller commits into; a spec
 * that changes a setting without going through the panel writes the same symbol
 * the panel writes.
 * @param leaf - the volatile reference to change.
 * @param value - the value to commit.
 */
function commit(leaf: unknown, value: unknown): void {
  ;(leaf as Record<symbol, (next: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value)
}

/**
 * Run the registered command.
 * @param harness - the harness whose command registry to read.
 * @param input - everything after the command name.
 * @param cwd - the working directory the session reports.
 * @returns the settlement text.
 */
async function run(
  harness: ReturnType<typeof createHarness>,
  input: string,
  cwd?: string,
): Promise<string> {
  const command = harness.commands[0]
  if (command === undefined) throw new Error('the command was not registered')
  const result = (await command.handler({ ...invocation(cwd), rawInput: input })) as {
    text?: string
  }
  return result.text ?? ''
}

describe('/dev-workflow', () => {
  it('registers the command so that off can be undone', async () => {
    const harness = createHarness({ commands: true })
    const runtime = createRuntime(harness.ctx, Config({ mode: 'on', locale: 'en-US' }))
    expect(harness.commands).toHaveLength(1)

    const off = await run(harness, 'off')
    expect(off).toContain('this session')
    // The way back is printed, not left to the reader's memory.
    expect(off).toContain('on')
    expect(harness.commands).toHaveLength(1)
    expect(runtime.active).toBe(false)

    const back = await run(harness, 'on')
    expect(back).not.toContain('unknown')
    expect(runtime.active).toBe(true)
  })

  it('keeps a manual off through an unrelated settings write', async () => {
    const harness = createHarness({ commands: true })
    const config = Config({ mode: 'on', locale: 'en-US' })
    const runtime = createRuntime(harness.ctx, config)

    await run(harness, 'off')
    expect(runtime.active).toBe(false)

    // What the panel writes when a user changes the locale or any other setting
    // that is not one of the registration switches. Before the `manualOff` flag,
    // this re-activated the plugin because `off` had cleared the signature it is
    // compared against.
    commit(config.locale, 'zh-CN')
    for (const listener of harness.volatile) listener()
    expect(runtime.active).toBe(false)

    // A setting that turns the plugin off outright agrees with the manual off
    // rather than fighting it; `mode` is the configuration's own answer to the
    // same question, so it is the one edit that does end the withdrawal.
    commit(config.mode, 'off')
    for (const listener of harness.volatile) listener()
    expect(runtime.active).toBe(false)

    commit(config.mode, 'on')
    for (const listener of harness.volatile) listener()
    expect(runtime.active).toBe(true)
  })

  it('reports a runtime off differently from a configured off', async () => {
    const manual = createHarness({ commands: true })
    const manualConfig = Config({ mode: 'on', locale: 'en-US' })
    const manualRuntime = createRuntime(manual.ctx, manualConfig)

    const configured = createHarness({ commands: true })
    const configuredConfig = Config({ mode: 'on', locale: 'en-US' })
    const configuredRuntime = createRuntime(configured.ctx, configuredConfig)

    const running = await run(manual, 'status')
    await run(manual, 'off')
    const runtimeOff = await run(manual, 'status')
    expect(runtimeOff).not.toBe(running)
    expect(manualRuntime.active).toBe(false)

    // The other kind of off is the configuration's: the plugin is withdrawn and
    // the command survives, because the command is the door either way.
    commit(configuredConfig.mode, 'off')
    for (const listener of configured.volatile) listener()
    expect(configuredRuntime.active).toBe(false)
    const configuredOff = await run(configured, 'status')

    // The two are distinguishable in text, not just in the `active` flag: one is
    // undone by `/dev-workflow on`, the other only by the configuration.
    expect(runtimeOff).not.toBe(configuredOff)
  })

  it('says whether this repository is in scope, because the status is a bug report', async () => {
    // `scope: 'marked'` is the one setting that makes the plugin do nothing at
    // all, silently. The most likely per-repository report is therefore "it
    // ignored my commit here", and a status that omits the scope cannot answer
    // it — the reader would have to be asked for a second round trip.
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-scope-'))
    roots.push(root)
    const unmarked = join(root, 'unmarked')
    const marked = join(root, 'marked')
    for (const dir of [unmarked, marked]) {
      mkdirSync(join(dir, '.git'), { recursive: true })
    }
    mkdirSync(join(marked, dirname(SCOPE_MARKER)), { recursive: true })
    writeFileSync(join(marked, SCOPE_MARKER), '')

    const harness = createHarness({ commands: true })
    const config = Config({ mode: 'on', locale: 'en-US' })
    createRuntime(harness.ctx, config)

    // The default is `all`, and it says so for a repository with no marker.
    expect(await run(harness, 'status', unmarked)).toContain('Scope: every repository')

    commit(config.scope, 'marked')
    for (const listener of harness.volatile) listener()

    // Same configuration, two repositories: the answer differs, and the
    // unmarked one names the file that would opt it in.
    const off = await run(harness, 'status', unmarked)
    expect(off).toContain('NOT marked')
    expect(off).toContain(join(unmarked, SCOPE_MARKER))

    const on = await run(harness, 'status', marked)
    expect(on).toContain('is marked')
    expect(on).not.toContain('NOT marked')
  })

  it('opts a repository in and out without the user creating the file by hand', async () => {
    // The hint used to end at "create this path", which is where the feature
    // stops being usable: the directory does not exist, the file has no content
    // to copy, and nothing says whether it should be committed.
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-mark-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })

    const harness = createHarness({ commands: true })
    const config = Config({ mode: 'on', locale: 'en-US' })
    createRuntime(harness.ctx, config)
    commit(config.scope, 'marked')
    for (const listener of harness.volatile) listener()

    expect(await run(harness, 'status', root)).toContain('/dev-workflow mark')

    const marked = await run(harness, 'mark', root)
    expect(marked).toContain(join(root, SCOPE_MARKER))
    // The marker is on disk and the status line already agrees, so one command
    // answers both "did that work" and "what changed".
    expect(existsSync(join(root, SCOPE_MARKER))).toBe(true)
    expect(marked).toContain('is marked')

    const again = await run(harness, 'unmark', root)
    expect(again).toContain(join(root, SCOPE_MARKER))
    expect(existsSync(join(root, SCOPE_MARKER))).toBe(false)

    // Unmarking twice is a mistake worth naming rather than a silent success.
    const nothing = await run(harness, 'unmark', root)
    expect(nothing).toContain('already opted out')
    expect(nothing).toContain(join(root, SCOPE_MARKER))
  })

  it('says when a guard hit was waved through rather than stopped', async () => {
    // A bare count reads the same whether the guard blocked three pushes or the
    // user relaxed the field and it let three through. Only `allow` outlives the
    // moment it was chosen, so only `allow` gets named here.
    const harness = createHarness({ commands: true })
    const runtime = createRuntime(harness.ctx, Config({ mode: 'on', locale: 'en-US' }))

    runtime.state.recordGuardHit('security.guard.force_push', 'deny')
    runtime.state.recordGuardHit('security.guard.force_push', 'deny')
    runtime.state.recordGuardHit('security.guard.outward_push', 'allow')

    const text = await run(harness, 'status')
    expect(text).toContain(
      "A force push rewrites remote history and can discard other people's commits.×2",
    )
    expect(text).toContain(
      'A push publishes this branch to the remote, where other people can see it. (allowed)×1',
    )
  })
})
