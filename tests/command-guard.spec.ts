import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import { createCommandGuard, detectCommand } from '../src/guard/command-guard.js'
import { allow, makeExec } from './harness.js'

// The command guard recognises shell commands whose damage git cannot undo. Two
// properties are asserted throughout: the default policy never blocks a call
// silently — it asks — and an ordinary command of the same shape passes.

const t = createTranslator('en-US')

/**
 * Recognise one command under a policy.
 * @param command - the command line.
 * @param action - the configured `commandGuard.dangerousShell`.
 * @returns the reason and policy, or undefined for an ordinary command.
 */
function classify(command: string, action: 'deny' | 'ask' | 'allow' = 'ask') {
  const hit = detectCommand(command, Config({ commandGuard: { dangerousShell: action } }))
  return hit === undefined ? undefined : { reason: hit.reason, action: hit.action }
}

/**
 * Run the guard over one command.
 * @param command - the command line.
 * @param options - policy, downstream decision, and cancellation.
 * @returns the decision and the resulting tally.
 */
async function run(
  command: string,
  options: {
    action?: 'deny' | 'ask' | 'allow'
    downstream?: Awaited<ReturnType<typeof allow>>
    aborted?: boolean
  } = {},
) {
  const state = createWorkflowState()
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()
  const guard = createCommandGuard({
    config: () => Config({ commandGuard: { dangerousShell: options.action ?? 'ask' } }),
    t: () => t,
    state,
    log: () => {},
  })
  const decision = await guard(makeExec(command, { signal: controller.signal }), async () => {
    return options.downstream ?? (await allow())
  })
  return { decision, state }
}

describe('src/guard/command-guard.ts', () => {
  it('recognises a recursive forced delete aimed at a filesystem root', () => {
    for (const command of [
      'rm -rf /',
      'rm -fr /',
      'rm -rf /*',
      'rm -Rf /etc',
      'sudo rm -rf /',
      'rm --recursive --force /',
      'rm -rf ~',
      'rm -rf ~/',
      'rm -rf $HOME',
      'rm -rf $HOME/',
      'rm -rf ${HOME}',
      'rm -rf .',
      'rm -rf *',
    ]) {
      expect(classify(command)?.reason, command).toBe('command.guard.dangerous_warning')
    }
  })

  it('recognises a filesystem being reformatted', () => {
    expect(classify('mkfs.ext4 /dev/sda1')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('mkfs /dev/sda1')?.reason).toBe('command.guard.dangerous_warning')
  })

  it('recognises raw writes to a block device', () => {
    expect(classify('dd if=/dev/zero of=/dev/sda')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('cat image.iso > /dev/sda')?.reason).toBe('command.guard.dangerous_warning')
  })

  it('recognises the shell fork bomb', () => {
    expect(classify(':(){ :|:& };:')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify(':() { :|:& };:')?.reason).toBe('command.guard.dangerous_warning')
  })

  it('recognises a recursive chmod that opens a system directory', () => {
    expect(classify('chmod -R 777 /')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('chmod -R 777 /etc')?.reason).toBe('command.guard.dangerous_warning')
  })

  it('recognises a dangerous command after a separator or a wrapper', () => {
    expect(classify('cd /tmp && rm -rf /')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('FOO=1 rm -rf /')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('sudo rm -rf /')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('nohup doas rm -rf /')?.reason).toBe('command.guard.dangerous_warning')
  })

  it('passes an ordinary delete, including a recursive one', () => {
    expect(classify('rm build.log')).toBeUndefined()
    expect(classify('rm -rf node_modules')).toBeUndefined()
    expect(classify('rm -rf ./dist')).toBeUndefined()
    expect(classify('rm -rf /tmp/build')).toBeUndefined()
    expect(classify('git clean -fd')).toBeUndefined()
  })

  it('passes ordinary commands of the same shape', () => {
    // Every `mkfs*` invocation is flagged, target or not: the program exists only
    // to erase a filesystem, and asking about a bare usage line costs one prompt.
    expect(classify('mkfs')?.reason).toBe('command.guard.dangerous_warning')
    expect(classify('dd if=image.iso of=out.img')).toBeUndefined()
    expect(classify('chmod 755 script.sh')).toBeUndefined()
    expect(classify('chmod -R 755 ./dist')).toBeUndefined()
    expect(classify('echo "rm -rf /"')).toBeUndefined()
    expect(classify('pnpm test')).toBeUndefined()
  })

  it('applies the configured tier: ask by default, never allow silently', () => {
    expect(classify('rm -rf /')?.action).toBe('ask')
    expect(classify('rm -rf /', 'deny')?.action).toBe('deny')
    expect(classify('rm -rf /', 'allow')?.action).toBe('allow')
  })

  it('asks by default, with a reason naming the pattern and no shell echo', async () => {
    const { decision } = await run('rm -rf /')
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') return
    expect(decision.reason).toContain('rm -rf')
    expect(decision.displayReason?.en).toContain('rm -rf')
    expect(decision.displayReason?.zh).toContain('rm -rf')
  })

  it('refuses outright when the configured tier is deny', async () => {
    const { decision, state } = await run('mkfs.ext4 /dev/sda1', { action: 'deny' })
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') return
    expect(decision.reason).toContain('mkfs')
    expect(state.guardHits()).toEqual({ 'command.guard.dangerous_warning': 1 })
  })

  it('passes the call through when the configured tier is allow', async () => {
    const { decision, state } = await run('rm -rf /', { action: 'allow' })
    expect(decision.kind).toBe('allow')
    // An allowed operation is not a hit: it was never guarded.
    expect(state.guardHits()).toEqual({})
  })

  it('leaves an ordinary call to the other gates', async () => {
    const { decision, state } = await run('pnpm build')
    expect(decision.kind).toBe('allow')
    expect(state.guardHits()).toEqual({})
  })

  it('does not weaken a refusal another gate already made', async () => {
    const { decision } = await run('rm -rf /', {
      downstream: { kind: 'deny', reason: 'downstream says no' },
    })
    expect(decision).toEqual({ kind: 'deny', reason: 'downstream says no' })
  })

  it('stays cancelled when the call was already aborted', async () => {
    const { decision } = await run('rm -rf /', { aborted: true })
    expect(decision.kind).toBe('cancel')
  })

  it('lets its own deny outrank a downstream allow', async () => {
    const { decision } = await run('rm -rf /', { action: 'deny' })
    expect(decision.kind).toBe('deny')
  })

  it('ignores a tool that does not run a shell command', async () => {
    const state = createWorkflowState()
    const guard = createCommandGuard({
      config: () => Config({}),
      t: () => t,
      state,
      log: () => {},
    })
    const exec = makeExec('', { tool: 'read', arguments: { file_path: '/etc/hosts' } })
    expect(await guard(exec, allow)).toEqual({ kind: 'allow' })
  })

  it('registers nothing when the guard is disabled', () => {
    const config = Config({ commandGuard: { enabled: false } })
    expect(detectCommand('rm -rf /', config)).toBeUndefined()
  })
})
