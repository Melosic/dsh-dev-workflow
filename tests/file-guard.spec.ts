import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import { createFileGuard, detectFile, matchesPattern } from '../src/guard/file-guard.js'
import { allow, makeExec } from './harness.js'

// The file guard is the read half of "sensitive files must not be read". DSH has
// no pre-read hook, so the guard classifies the call's own arguments on the gate
// every guard shares. It matches path strings and never opens anything.

const t = createTranslator('en-US')

/**
 * Classify one path argument under the default rules.
 * @param path - the path a call names.
 * @param tool - the tool name, defaulting to `read`.
 * @returns the reason and parameters, or undefined for an ordinary path.
 */
function classify(path: string, tool = 'read') {
  const hit = detectFile({ file_path: path }, tool, Config({}))
  return hit === undefined ? undefined : { reason: hit.reason, params: hit.params }
}

describe('src/guard/file-guard.ts', () => {
  it('refuses a call that names a dotenv file', () => {
    expect(classify('.env')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('/repo/.env')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('C:\\repo\\.env')?.reason).toBe('security.sensitive_file_blocked')
  })

  it('refuses the variants a dotenv file is split into', () => {
    expect(classify('.env.local')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('.env.production')?.reason).toBe('security.sensitive_file_blocked')
  })

  it('reads a documented sample instead, because it holds no secret', () => {
    // `.gitignore` keeps `.env.example` trackable on purpose; refusing it would
    // only teach the agent to stop using the guard.
    expect(classify('.env.example')).toBeUndefined()
    expect(classify('config/.env.sample')).toBeUndefined()
    expect(classify('.env.local.example')?.params.rule).toBe('.env')
  })

  it('refuses an ssh private key at any depth', () => {
    expect(classify('.ssh/id_rsa')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('C:/Users/x/.ssh/id_rsa')?.reason).toBe('security.sensitive_file_blocked')
  })

  it('refuses key and certificate material by extension', () => {
    expect(classify('certs/server.pem')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('certs/server.key')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('keys/client.p12')?.reason).toBe('security.sensitive_file_blocked')
  })

  it('refuses a credentials file and anything under secrets/', () => {
    expect(classify('credentials')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('secrets/token.txt')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('config/secrets/db.json')?.reason).toBe('security.sensitive_file_blocked')
  })

  it('refuses npmrc', () => {
    expect(classify('.npmrc')?.reason).toBe('security.sensitive_file_blocked')
    expect(classify('/home/x/.npmrc')?.reason).toBe('security.sensitive_file_blocked')
  })

  it('names the file and the rule without reading anything', () => {
    const hit = classify('/repo/.env')
    expect(hit?.params).toEqual({ file: '/repo/.env', rule: '.env' })
  })

  it('passes ordinary files', () => {
    expect(classify('src/index.ts')).toBeUndefined()
    expect(classify('README.md')).toBeUndefined()
    expect(classify('docs/SECURITY.md')).toBeUndefined()
    // Not a sensitive name: the `.env` rule does not cover `environment.ts`.
    expect(classify('src/environment.ts')).toBeUndefined()
    expect(classify('package.json')).toBeUndefined()
  })

  it('reads the argument field each tool actually uses', () => {
    const paths: ReadonlyArray<[Record<string, string>, string]> = [
      [{ file_path: '/repo/.env' }, 'read'],
      [{ file_path: '/repo/.env' }, 'edit'],
      [{ file_path: '/repo/.env' }, 'write'],
      [{ file_path: '/repo/.env' }, 'read_image'],
      [{ path: '/repo/.env' }, 'grep'],
      [{ pattern: '/repo/.env' }, 'glob'],
    ]
    for (const [args, tool] of paths) {
      expect(detectFile(args, tool, Config({})), tool).toMatchObject({
        reason: 'security.sensitive_file_blocked',
        params: { rule: '.env' },
      })
    }
  })

  it('does not mistake a prose mention for a path argument', () => {
    // `read` has no field holding free text, and `edit`'s old_string is not a path.
    expect(detectFile({ old_string: 'cat .env' }, 'edit', Config({}))).toBeUndefined()
    expect(detectFile({ content: 'AWS_KEY=placeholder' }, 'write', Config({}))).toBeUndefined()
  })

  it('refuses a shell command that prints a sensitive file', () => {
    expect(detectFile({ command: 'cat .env' }, 'bash', Config({}))?.params.rule).toBe('.env')
    expect(detectFile({ command: 'cat /repo/.ssh/id_rsa' }, 'bash', Config({}))?.params.rule).toBe(
      '.ssh/id_rsa',
    )
    expect(detectFile({ command: 'grep AWS .env' }, 'bash', Config({}))?.params.rule).toBe('.env')
  })

  it('passes a shell command that only mentions the name', () => {
    expect(
      detectFile({ command: 'echo "add .env to gitignore"' }, 'bash', Config({})),
    ).toBeUndefined()
    expect(detectFile({ command: 'ls -la' }, 'bash', Config({}))).toBeUndefined()
    expect(detectFile({ command: 'git status' }, 'bash', Config({}))).toBeUndefined()
  })

  it('matches a directory pattern against its contents only', () => {
    expect(matchesPattern('secrets/a.json', 'secrets/')).toBe(true)
    expect(matchesPattern('config/secrets/a.json', 'secrets/')).toBe(true)
    expect(matchesPattern('src/secrets.ts', 'secrets/')).toBe(false)
  })

  it('matches a pattern with a slash at any depth', () => {
    expect(matchesPattern('.ssh/id_rsa', '.ssh/id_rsa')).toBe(true)
    expect(matchesPattern('/home/x/.ssh/id_rsa', '.ssh/id_rsa')).toBe(true)
  })

  it('is case-insensitive, because a path may be written either way', () => {
    expect(matchesPattern('C:/Repo/.ENV', '.env')).toBe(true)
    expect(matchesPattern('Server.PEM', '*.pem')).toBe(true)
  })

  it('refuses by default rather than asking', async () => {
    const state = createWorkflowState()
    const guard = createFileGuard({
      config: () => Config({}),
      t: () => t,
      state,
      log: () => {},
    })
    const exec = makeExec('', { tool: 'read', arguments: { file_path: '.env' } })
    const decision = await guard(exec, allow)
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') return
    // Actionable: it names the file and the rule, so the refusal reads as
    // intentional rather than as a misfire.
    expect(decision.reason).toContain('.env')
    expect(state.guardHits()).toEqual({ 'security.sensitive_file_blocked': 1 })
  })

  it('leaves an ordinary read to the other gates', async () => {
    const state = createWorkflowState()
    const guard = createFileGuard({
      config: () => Config({}),
      t: () => t,
      state,
      log: () => {},
    })
    const exec = makeExec('', { tool: 'read', arguments: { file_path: 'src/index.ts' } })
    expect(await guard(exec, allow)).toEqual({ kind: 'allow' })
    expect(state.guardHits()).toEqual({})
  })

  it('honours a configured pattern list', () => {
    const config = Config({ fileGuard: { noRead: ['*.vault'] } })
    expect(detectFile({ file_path: 'a.vault' }, 'read', config)?.params.rule).toBe('*.vault')
    // The built-in list was replaced, not extended.
    expect(detectFile({ file_path: '.env' }, 'read', config)).toBeUndefined()
  })

  it('registers nothing when the guard is disabled', () => {
    const config = Config({ fileGuard: { enabled: false } })
    expect(detectFile({ file_path: '.env' }, 'read', config)).toBeUndefined()
  })

  it('registers nothing when the pattern list is empty', () => {
    const config = Config({ fileGuard: { noRead: [] } })
    expect(detectFile({ file_path: '.env' }, 'read', config)).toBeUndefined()
  })
})
