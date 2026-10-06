import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import * as plugin from '../src/index.js'
import { createHarness } from './harness.js'

// `tests/harness.ts` stands in for the DSH services, and fifteen other specs
// trust it. Nothing checked that it was still a faithful stand-in: a service the
// plugin starts reading, but the harness never learned to record, would look
// like "the plugin registered nothing" in every one of those specs at once.
//
// So this walks the real plugin against a proxied harness and fails on any
// context property the plugin reaches for. The expected list below is the point
// of the test, not an implementation detail: adding a service to `apply` means
// teaching the harness about it and writing it down here.

describe('createHarness', () => {
  it('provides every context property the plugin reaches for', () => {
    const harness = createHarness({ commands: true, settings: true })
    const touched = new Set<string>()
    const ctx = new Proxy(harness.ctx as unknown as Record<string, unknown>, {
      get: (target, property, receiver) => {
        if (typeof property === 'string') touched.add(property)
        return Reflect.get(target, property, receiver)
      },
    })

    plugin.apply(ctx as never, Config({}))

    expect([...touched].sort()).toEqual([
      'effect',
      'events',
      'fiber',
      'get',
      'inject',
      'logger',
      'on',
      'skills',
      'tools',
    ])
    // Every one of them is a real value, not `undefined` silently swallowing a
    // registration the spec counted as "the plugin did nothing".
    for (const key of touched) {
      expect(harness.ctx[key as keyof typeof harness.ctx]).toBeDefined()
    }

    // And the registrations really landed. A context property that exists but
    // records nothing is the failure this whole file is about.
    expect(harness.tools).toHaveLength(2)
    expect(harness.providers).toHaveLength(1)
    expect(harness.listeners).toHaveLength(7)
  })

  it('records the settings presentation only when that service is present', () => {
    const without = createHarness()
    plugin.apply(without.ctx, Config({}))
    expect(without.presentations).toHaveLength(0)

    const with_ = createHarness({ settings: true })
    plugin.apply(with_.ctx, Config({}))
    expect(with_.presentations.map((entry) => entry.page)).toEqual([{ auto: false }])
  })

  it('records the volatile-update listener the runtime resyncs from', () => {
    const harness = createHarness({ settings: true })
    plugin.apply(harness.ctx, Config({}))
    expect(harness.volatile).toHaveLength(1)
  })
})
