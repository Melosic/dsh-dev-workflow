import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { createFormScope, loadPanel, plain, type FormScope } from './harness.js'

// What the panel is for: an edit made in the browser has to reach the
// configuration the running plugin reads, without a restart and without the
// file being touched by anything but the settings controller. The scope here
// applies writes the way the host does, so a roundtrip is the real one.

interface Form {
  getSnapshot(): {
    readonly dirty: boolean
    readonly invalid: boolean
    readonly saving: boolean
    readonly failed: boolean
    read(path: readonly string[]): unknown
    overridden(path: readonly string[]): boolean
  }
  edit(path: readonly string[], value: unknown): void
  clear(path: readonly string[]): void
  discard(): void
  save(): Promise<void>
}

interface DocumentAction {
  getSnapshot(): { readonly opening: boolean; readonly error: string | null }
  open(): Promise<void>
}

const subjectMaxLength = ['commitCheck', 'subjectMaxLength'] as const

const build = async (
  options: { config?: unknown; user?: unknown } = {},
): Promise<{ config: Config; scope: FormScope; form: Form; document: DocumentAction }> => {
  const config = (options.config ?? Config({})) as Config
  const scope = createFormScope(config, { user: options.user })
  const panel = await loadPanel(scope)
  return {
    config,
    scope,
    form: panel.injected.hooks.form as Form,
    document: panel.injected.hooks.document as DocumentAction,
  }
}

describe('client.js read/write roundtrip', () => {
  it('reads the stored value before anything is staged', async () => {
    const { form } = await build()

    expect(form.getSnapshot().read(subjectMaxLength)).toBe(50)
    expect(form.getSnapshot().dirty).toBe(false)
  })

  it('commits a staged edit into the live configuration', async () => {
    const { config, scope, form } = await build()

    form.edit(subjectMaxLength, 72)
    // Staging never touches the plugin's configuration.
    expect(form.getSnapshot().dirty).toBe(true)
    expect(config.commitCheck.subjectMaxLength.get()).toBe(50)

    await form.save()

    expect(config.commitCheck.subjectMaxLength.get()).toBe(72)
    expect(form.getSnapshot().dirty).toBe(false)
    expect(scope.writes).toEqual([
      [{ op: 'set', path: ['commitCheck', 'subjectMaxLength'], value: 72 }],
    ])
    // The batch carried the revision the panel read, so a stale draft conflicts
    // instead of overwriting whoever wrote in between.
    expect(scope.revisions).toEqual([0])
  })

  it('sends one fenced batch for edits spread over several groups', async () => {
    const { config, scope, form } = await build()

    form.edit(['mode'], 'off')
    form.edit(['gitGuard', 'forcePush'], 'deny')
    form.edit(['commitCheck', 'types'], ['feat', 'docs'])
    await form.save()

    expect(scope.writes).toHaveLength(1)
    expect(scope.writes[0]).toHaveLength(3)
    expect(scope.revisions).toEqual([0])
    expect(config.mode.get()).toBe('off')
    expect(plain(config.gitGuard.forcePush)).toBe('deny')
    expect(plain(config.commitCheck.types)).toEqual(['feat', 'docs'])
  })

  it('keeps the draft when the host rejects the write', async () => {
    const { config, scope, form } = await build()

    form.edit(subjectMaxLength, 72)
    scope.failWrites(1)
    await form.save()

    expect(form.getSnapshot().failed).toBe(true)
    expect(form.getSnapshot().dirty).toBe(true)
    expect(form.getSnapshot().read(subjectMaxLength)).toBe(72)
    expect(config.commitCheck.subjectMaxLength.get()).toBe(50)

    // Retrying without re-editing lands it.
    await form.save()

    expect(form.getSnapshot().failed).toBe(false)
    expect(form.getSnapshot().dirty).toBe(false)
    expect(config.commitCheck.subjectMaxLength.get()).toBe(72)
  })

  it('refuses to save a value the host schema rejects', async () => {
    const { config, scope, form } = await build()

    form.edit(subjectMaxLength, 0)

    expect(form.getSnapshot().invalid).toBe(true)
    await form.save()
    expect(scope.writes).toEqual([])
    expect(config.commitCheck.subjectMaxLength.get()).toBe(50)

    form.edit(subjectMaxLength, 12)
    expect(form.getSnapshot().invalid).toBe(false)
    await form.save()
    expect(config.commitCheck.subjectMaxLength.get()).toBe(12)
  })

  it('drops a staged value that restates what is stored', async () => {
    const { scope, form } = await build()

    form.edit(subjectMaxLength, 50)

    expect(form.getSnapshot().dirty).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([])
  })

  it('discards the draft without writing anything', async () => {
    const { config, scope, form } = await build()

    form.edit(['mode'], 'off')
    form.discard()

    expect(form.getSnapshot().dirty).toBe(false)
    expect(scope.writes).toEqual([])
    expect(config.mode.get()).toBe('on')
  })

  it('puts an overridden field back to the inherited value', async () => {
    const config = Config({ commitCheck: { subjectMaxLength: 72 } })
    const { scope, form } = await build({
      config,
      user: { commitCheck: { subjectMaxLength: 72 } },
    })

    expect(form.getSnapshot().overridden(subjectMaxLength)).toBe(true)

    form.clear(subjectMaxLength)
    await form.save()

    expect(scope.writes).toEqual([[{ op: 'unset', path: ['commitCheck', 'subjectMaxLength'] }]])
    expect(config.commitCheck.subjectMaxLength.get()).toBe(50)
    expect(form.getSnapshot().overridden(subjectMaxLength)).toBe(false)
  })

  // The platform marks a field overridden by the user layer *carrying* the
  // entry, not by its value, so writing the default back would have kept the
  // badge and a reset button that resets nothing. Choosing the inherited value
  // is how a user says "stop overriding this", so it has to unset the entry.
  it('unsets an overridden field when the inherited value is chosen again', async () => {
    const config = Config({ commitCheck: { subjectMaxLength: 72 } })
    const { scope, form } = await build({
      config,
      user: { commitCheck: { subjectMaxLength: 72 } },
    })

    form.edit(subjectMaxLength, 50)

    expect(form.getSnapshot().dirty).toBe(true)
    expect(form.getSnapshot().overridden(subjectMaxLength)).toBe(false)
    expect(form.getSnapshot().read(subjectMaxLength)).toBe(50)
    await form.save()

    expect(scope.writes).toEqual([[{ op: 'unset', path: ['commitCheck', 'subjectMaxLength'] }]])
    expect(plain(config.commitCheck.subjectMaxLength)).toBe(50)
  })

  it('rejects a draft written against a stale revision', async () => {
    const { config, scope, form } = await build()

    form.edit(['mode'], 'off')
    // Somebody else writes first, so the revision the panel read is gone.
    await scope.mutate([{ op: 'set', path: ['locale'], value: 'en-US' }], 0)
    await form.save()

    expect(form.getSnapshot().failed).toBe(true)
    expect(config.mode.get()).toBe('on')
    expect(scope.revisions).toEqual([0, 0])
    expect(plain(config.locale)).toBe('en-US')
  })

  it('reflects a value written outside the panel', async () => {
    const { config, scope, form } = await build()

    expect(form.getSnapshot().read(subjectMaxLength)).toBe(50)

    // The host pushes a new view — another client edited, or the file reloaded.
    await scope.mutate([{ op: 'set', path: ['commitCheck', 'subjectMaxLength'], value: 88 }], 0)

    expect(config.commitCheck.subjectMaxLength.get()).toBe(88)
    expect(form.getSnapshot().read(subjectMaxLength)).toBe(88)

    // A draft in progress stays what the panel shows until it is saved or
    // discarded; the write that lands is fenced on the revision it read.
    form.edit(['mode'], 'off')
    await scope.mutate([{ op: 'set', path: ['commitCheck', 'subjectMaxLength'], value: 92 }], 1)

    expect(form.getSnapshot().read(subjectMaxLength)).toBe(92)
    expect(form.getSnapshot().read(['mode'])).toBe('off')
  })

  it('opens the profile document and reports a refusal', async () => {
    const { scope, document } = await build()

    scope.answerOpen({ ok: false, error: { message: 'no editor' } })
    await document.open()

    expect(document.getSnapshot().error).toBe('no editor')
    expect(document.getSnapshot().opening).toBe(false)

    await document.open()

    expect(document.getSnapshot().error).toBe(null)
  })
})
