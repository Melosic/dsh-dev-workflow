import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import * as plugin from '../src/index.js'
import { SCOPE_MARKER, applies, marked, projectRoot } from '../src/scope.js'
import { createHarness, makeExec } from './harness.js'

// A profile is per machine and the rules are a property of the repository, so
// `scope: 'marked'` is what lets one install serve both kinds of repository.
// The two ways this can go wrong are opposite: a marked repository that is not
// checked (the guard is silently gone) and an unmarked one that is (the plugin
// still pays everywhere, which is what the switch was supposed to stop).

const made: string[] = []

/**
 * Build a throwaway directory tree.
 * @param layout - relative paths to create; a trailing `/` means a directory,
 *   anything else a file whose parent directories are created for it.
 * @returns the absolute root.
 */
function tree(layout: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-scope-'))
  made.push(root)
  for (const entry of layout) {
    const target = join(root, entry)
    if (entry.endsWith('/')) mkdirSync(target, { recursive: true })
    else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '')
    }
  }
  return root
}

afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true })
})

describe('src/scope.ts', () => {
  it('finds the nearest repository root above a subdirectory', () => {
    const root = tree(['.git/', 'packages/app/src/'])
    const deep = join(root, 'packages', 'app', 'src')
    expect(projectRoot(deep)).toBe(root)
  })

  it('answers with the working directory itself when nothing above is a repository', () => {
    const root = tree(['loose/'])
    const inside = join(root, 'loose')
    expect(projectRoot(inside)).toBe(inside)
  })

  it('reads the marker from the root, not from the working directory', () => {
    const root = tree(['.git/', SCOPE_MARKER, 'nested/deeper/'])
    expect(marked(join(root, 'nested', 'deeper'))).toBe(true)
    // The marker has to be at the root: a copy in a subdirectory is not the
    // repository opting in, and treating it as one would let any vendored tree
    // switch the checks on.
    const other = tree(['.git/', 'nested/', join('nested', SCOPE_MARKER)])
    expect(marked(join(other, 'nested'))).toBe(false)
  })

  it('checks everything under `all`, marker or not', () => {
    const root = tree(['.git/'])
    expect(applies('all', root)).toBe(true)
  })

  it('checks only a marked repository under `marked`', () => {
    const on = tree(['.git/', SCOPE_MARKER])
    const off = tree(['.git/'])
    expect(applies('marked', on)).toBe(true)
    expect(applies('marked', off)).toBe(false)
  })

  it('does not refuse a caller that has no working directory', () => {
    // The skill catalog can be built before an agent has a directory. Answering
    // `false` there would hide the skill line from every session that starts
    // without one, which is a silent downgrade rather than a scoping decision.
    expect(applies('marked', undefined)).toBe(true)
  })
})

describe('scope on the registered gates', () => {
  // A force push, because the git guard asks about it under the default
  // configuration without needing a repository, a session, or a file: the
  // answer is decided by the gate alone, which is what this pair is about.
  const forcePush = (cwd: string) => makeExec('git push --force origin main', { cwd })
  const allow = async () => ({ kind: 'allow' as const })

  it('lets a marked repository reach the gates', async () => {
    const root = tree(['.git/', SCOPE_MARKER])
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({ scope: 'marked' }))
    // Every listener sees the same command; the guard among them asks.
    const kinds = await Promise.all(
      harness.listeners.map(
        async (listener) => (await listener.listener(forcePush(root), allow)).kind,
      ),
    )
    expect(kinds).toContain('ask')
  })

  it('lets an unmarked repository straight through, without asking', async () => {
    const root = tree(['.git/'])
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({ scope: 'marked' }))
    for (const listener of harness.listeners) {
      const decision = await listener.listener(forcePush(root), allow)
      expect(decision.kind).toBe('allow')
    }
  })

  it('stops enforcing a repository that loses its marker mid-session', async () => {
    // The marker is a file, and files move while a session runs. Caching the
    // answer with the root would keep enforcing a repository that opted out.
    const root = tree(['.git/', SCOPE_MARKER])
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({ scope: 'marked' }))
    const asks = async (): Promise<string[]> =>
      Promise.all(
        harness.listeners.map(
          async (listener) => (await listener.listener(forcePush(root), allow)).kind,
        ),
      )
    expect(await asks()).toContain('ask')
    rmSync(join(root, SCOPE_MARKER))
    expect(await asks()).not.toContain('ask')
  })
})

describe('scope on the skill catalog', () => {
  // The catalog line is resident cost, so an unmarked repository must not be
  // paying for it. `off` already reaches zero; this is the second way to reach
  // zero, and it has to reach it the same way.
  const provider = async (scope: 'all' | 'marked') => {
    const harness = createHarness()
    plugin.apply(harness.ctx, Config({ scope }))
    const factory = harness.providers[0]
    if (factory === undefined) throw new Error('no provider registered')
    return factory() as {
      list: (options: { cwd?: string }) => Promise<readonly unknown[]>
      get: (candidate: unknown, options: { cwd?: string }) => Promise<unknown>
    }
  }

  it('lists the skill in a marked repository', async () => {
    const root = tree(['.git/', SCOPE_MARKER])
    expect(await (await provider('marked')).list({ cwd: root })).toHaveLength(1)
  })

  it('lists nothing in an unmarked one', async () => {
    const root = tree(['.git/'])
    expect(await (await provider('marked')).list({ cwd: root })).toHaveLength(0)
  })

  it('still lists it everywhere under `all`', async () => {
    const root = tree(['.git/'])
    expect(await (await provider('all')).list({ cwd: root })).toHaveLength(1)
  })

  it('refuses to load a body for a repository that is out of scope', async () => {
    // A stale candidate from before the marker was removed would otherwise load
    // the whole specification into a repository that opted out.
    const root = tree(['.git/'])
    const skills = await provider('marked')
    expect(await skills.get({ name: 'dsh-dev-workflow' }, { cwd: root })).toBeUndefined()
  })
})
