import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { Config } from '../src/config.js'
import { createHarness } from './harness.js'

// The cordis contract: what the loader sees, and what `apply` hands to the
// registries. Everything here is a shape assertion — the behaviour of what gets
// registered is covered by the other specs.

describe('src/index.ts', () => {
  it('exposes the plugin as named exports, with no default export', () => {
    // The loader's `unwrapExports` keeps a namespace only when it has no
    // `default`; a default export would drop `inject` and `Config` on the floor.
    expect('default' in plugin).toBe(false)
    expect(Object.keys(plugin).sort()).toEqual([
      'Config',
      'apply',
      'createRuntime',
      'inject',
      'name',
    ])
  })

  it('declares a name the loader accepts', () => {
    expect(plugin.name).toBe('dev-workflow')
    expect(plugin.name).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('injects the two services it reads through the context', () => {
    // Service names, not package names: `subprocess` and `commands` are optional
    // capabilities read with `ctx.get`, so they are deliberately absent here.
    expect(plugin.inject).toEqual(['tools', 'skills'])
  })

  it('registers two tools, one skill provider, and every pre-execute gate', () => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({}))

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      'check_commit_message',
      'check_doc_sync',
    ])
    expect(harness.providers).toHaveLength(1)
    // The commit and pull-request triggers, then the git, command, file, and
    // secret guards.
    expect(harness.listeners.map((listener) => listener.name)).toEqual([
      'tools/pre-execute',
      'tools/pre-execute',
      'tools/pre-execute',
      'tools/pre-execute',
      'tools/pre-execute',
      'tools/pre-execute',
    ])
    // Two tools, one provider, six listeners — one effect each.
    expect(harness.effects).toHaveLength(9)
  })

  it('skips the command when the profile has no command service', () => {
    const harness = createHarness({ commands: true })
    plugin.apply(harness.ctx, Config({}))
    expect(harness.commands.map((command) => command.name)).toEqual(['dev-workflow'])
    expect(harness.effects).toHaveLength(10)
  })

  it('registers only the guards that are enabled', () => {
    const harness = createHarness()
    plugin.apply(
      harness.ctx,
      Config({
        enableOwnTrigger: false,
        gitGuard: { enabled: false },
        secretGuard: { enabled: false },
      }),
    )
    // Two tools, one provider, and only the command and file guards.
    expect(harness.listeners).toHaveLength(2)
    expect(harness.effects).toHaveLength(5)
  })

  it('declares both tools with a name the registry accepts', () => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({}))
    for (const tool of harness.tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64)
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })

  it('describes each tool with normalised parameters and output', () => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({}))
    const [commit, docs] = harness.tools

    expect(commit?.parameters.type).toBe('object')
    expect(Object.keys(commit?.parameters.properties ?? {}).sort()).toEqual(['files', 'message'])
    expect(commit?.parameters.required ?? []).toContain('message')

    expect(docs?.parameters.type).toBe('object')
    expect(Object.keys(docs?.parameters.properties ?? {})).toEqual(['files'])
    // `files` is optional: without it the tool reads the working tree itself.
    expect(docs?.parameters.required ?? []).not.toContain('files')

    for (const tool of harness.tools) {
      expect(tool.output.schema.type).toBe('object')
      expect(Object.keys(tool.output.schema.properties).sort()).toEqual([
        'error',
        'errors',
        'ok',
        'warnings',
      ])
      expect(tool.output.schema.required ?? []).toEqual(
        expect.arrayContaining(['ok', 'errors', 'warnings']),
      )
      expect(typeof tool.output.render).toBe('function')
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('leaves nothing registered while the mode is off', () => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({ mode: 'off' }))

    expect(harness.tools).toHaveLength(0)
    expect(harness.providers).toHaveLength(0)
    expect(harness.listeners).toHaveLength(0)
    expect(harness.effects).toHaveLength(0)
  })

  it('reports the mounted mode, locale, and trigger once', () => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({ locale: 'zh-CN', enableOwnTrigger: false }))
    expect(harness.logs).toEqual([
      '[dsh-dev-workflow] mounted (mode=on, locale=zh-CN, ownTrigger=false)',
    ])
  })
})

describe('createRuntime', () => {
  it('starts active in mode on and unregisters everything when turned off', () => {
    const harness = createHarness()
    const runtime = plugin.createRuntime(harness.ctx, Config({}))

    expect(runtime.active).toBe(true)
    expect(harness.tools).toHaveLength(2)
    expect(harness.listeners).toHaveLength(6)

    runtime.setActive(false)
    expect(runtime.active).toBe(false)
    expect(harness.tools).toHaveLength(0)
    expect(harness.providers).toHaveLength(0)
    expect(harness.listeners).toHaveLength(0)
  })

  it('starts inactive in mode off and registers on demand', () => {
    const harness = createHarness()
    const runtime = plugin.createRuntime(harness.ctx, Config({ mode: 'off' }))

    expect(runtime.active).toBe(false)
    runtime.setActive(true)
    expect(runtime.active).toBe(true)
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      'check_commit_message',
      'check_doc_sync',
    ])
  })

  it('ignores a request that matches the current state', () => {
    const harness = createHarness()
    const runtime = plugin.createRuntime(harness.ctx, Config({}))

    runtime.setActive(true)
    expect(harness.effects).toHaveLength(9)
    runtime.setActive(false)
    runtime.setActive(false)
    expect(runtime.active).toBe(false)
  })

  it('exposes a translator for the resolved locale', () => {
    const harness = createHarness()
    const runtime = plugin.createRuntime(harness.ctx, Config({ locale: 'zh-CN' }))
    expect(runtime.locale()).toBe('zh-CN')
    expect(runtime.t()('command.toggle.hint')).toBe('on | off | status | check')
  })

  it('reuses one git runner per working directory', () => {
    const harness = createHarness()
    const runtime = plugin.createRuntime(harness.ctx, Config({}))
    expect(runtime.git('C:/repo')).toBe(runtime.git('C:/repo'))
    expect(runtime.git('C:/repo')).not.toBe(runtime.git('C:/other'))
  })
})
