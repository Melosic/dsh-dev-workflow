import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { Config } from '../src/config.js'
import { createHarness } from './harness.js'

// The host half of the settings panel: what `apply` declares to the settings
// service, and what it does when the loader commits a configuration change into
// the references it is already holding.

/**
 * Commit a value into a volatile reference.
 *
 * This is what the loader's `updateVolatile` does when the panel writes a
 * setting. The write symbol comes from the global registry, which is exactly how
 * the protocol is found across copies of the library.
 */
const commit = (reference: unknown, value: unknown): void => {
  const writable = reference as { [key: symbol]: (next: unknown) => void }
  writable[Symbol.for('cosmokit.volatile.write')]!(value)
}

/** Deliver one loader-side change the way the loader does. */
const deliver = (harness: { readonly volatile: (() => void)[] }): void => {
  for (const listener of harness.volatile) listener()
}

describe('src/index.ts settings registration', () => {
  it('turns off the page the settings service would generate', () => {
    const harness = createHarness({ settings: true })
    plugin.apply(harness.ctx, Config({}))

    expect(harness.presentations).toHaveLength(1)
    expect(harness.presentations[0]!.page).toEqual({ auto: false })
    // The choice is keyed by fiber, so it has to name the plugin's own.
    expect(harness.presentations[0]!.owner).toBe(harness.ctx.fiber)
  })

  it('asks for nothing in a profile without the settings service', () => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({}))

    expect(harness.presentations).toHaveLength(0)
  })

  it('follows a locale written from outside the runtime', () => {
    const harness = createHarness()
    const config = Config({ locale: 'en-US' })
    const runtime = plugin.createRuntime(harness.ctx, config)

    expect(runtime.locale()).toBe('en-US')
    // Read once, translated once: the dictionary is rebuilt for the new locale
    // rather than only the reported name changing.
    expect(runtime.t()('command.toggle.status.on')).toBe(
      'dev-workflow is on. Conventions stay resident as a short summary; details are read on demand.',
    )

    commit(config.locale, 'zh-CN')
    deliver(harness)

    expect(runtime.locale()).toBe('zh-CN')
    expect(runtime.t()('command.toggle.status.on')).toBe(
      'dev-workflow 已开启。规范以简短摘要常驻，细节按需读取。',
    )
  })

  it('follows a mode written from outside the runtime', () => {
    const harness = createHarness()
    const config = Config({})
    const runtime = plugin.createRuntime(harness.ctx, config)
    expect(runtime.active).toBe(true)

    commit(config.mode, 'off')
    deliver(harness)
    expect(runtime.active).toBe(false)
    expect(harness.listeners).toHaveLength(0)

    // The runtime is off, but the mode says it should be on: the next loader
    // change has to bring the registrations back.
    commit(config.mode, 'on')
    deliver(harness)
    expect(runtime.active).toBe(true)
    expect(harness.listeners).toHaveLength(8)
  })

  it('rebuilds the registrations when a switch that gates one moves', () => {
    const harness = createHarness()
    const config = Config({})
    plugin.apply(harness.ctx, config)
    expect(harness.listeners).toHaveLength(8)

    // The git guard is registered or not at activation time, so switching it off
    // has to drop the listener, not merely make it answer differently.
    commit(config.gitGuard.enabled, false)
    deliver(harness)

    expect(harness.listeners).toHaveLength(7)
    expect(harness.tools).toHaveLength(2)
  })

  it('rebuilds the registrations for every switch that gates one', () => {
    // Each switch below decides whether something is registered at all, so it
    // belongs in the signature the runtime compares. A switch left out of that
    // list toggles in the panel and changes nothing until a restart.
    const switches: ReadonlyArray<
      [string, (config: ReturnType<typeof Config>) => unknown, number]
    > = [
      ['enableOwnTrigger', (config) => config.enableOwnTrigger, 5],
      ['gitGuard.enabled', (config) => config.gitGuard.enabled, 7],
      ['outwardGuard.enabled', (config) => config.outwardGuard.enabled, 7],
      ['commandGuard.enabled', (config) => config.commandGuard.enabled, 7],
      ['fileGuard.enabled', (config) => config.fileGuard.enabled, 7],
      ['secretGuard.enabled', (config) => config.secretGuard.enabled, 7],
    ]

    for (const [name, reference, off] of switches) {
      const harness = createHarness()
      const config = Config({})
      plugin.apply(harness.ctx, config)
      expect(harness.listeners, name).toHaveLength(8)

      commit(reference(config) as never, false)
      deliver(harness)
      expect(harness.listeners, name).toHaveLength(off)
    }
  })

  it('leaves the registrations alone when a setting read on demand moves', () => {
    const harness = createHarness()
    const config = Config({})
    plugin.apply(harness.ctx, config)
    const before = harness.listeners.slice()

    // The commit check reads its rules when it runs, so a new length must not
    // tear down and rebuild anything.
    commit(config.commitCheck.subjectMaxLength, 72)
    commit(config.commitCheck.onFailure, 'warn')
    deliver(harness)

    expect(harness.listeners).toEqual(before)
    expect(harness.tools).toHaveLength(2)
    expect(config.commitCheck.subjectMaxLength.get()).toBe(72)
  })
})
