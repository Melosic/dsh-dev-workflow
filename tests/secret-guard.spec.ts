import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { createTranslator } from '../src/i18n.js'
import { createWorkflowState } from '../src/state.js'
import {
  createSecretGuard,
  detectSecret,
  findSecret,
  redactSecrets,
  scanForSecret,
} from '../src/guard/secret-guard.js'
import { allow, makeExec } from './harness.js'

// A credential that reaches the model has already leaked. These tests pin two
// properties as much as the detection itself: nothing about what matched ever
// comes back out — no reason, no parameter, no audit field — and the guard does
// not depend on where in the arguments the secret happens to sit.

const t = createTranslator('en-US')

/** A syntactically valid AWS key, assembled so this file holds no real one. */
const AWS_KEY = `AKIA${'A'.repeat(16)}`
/** The same, for GitHub. */
const GITHUB_PAT = `ghp_${'b'.repeat(24)}`
/** And Slack. */
const SLACK_TOKEN = `xoxb-${'1234567890'.repeat(2)}`
/** A PEM header, which is what a private key starts with. */
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----'
/** A high-entropy string with no known prefix. */
const RANDOM_TOKEN = 'kZ9vQ2mX8pT4rL6nW1yB5cD7fH3jS0aGeU'

/**
 * Classify one arguments object under the default rules.
 * @param args - the call's arguments.
 * @returns the reason and pattern name, or undefined for an ordinary call.
 */
function classify(args: unknown) {
  const hit = detectSecret(args, Config({}))
  return hit === undefined ? undefined : { reason: hit.reason, params: hit.params }
}

describe('src/guard/secret-guard.ts', () => {
  it('refuses an AWS access key in a command', () => {
    expect(classify({ command: `aws configure set aws_access_key_id ${AWS_KEY}` })?.reason).toBe(
      'security.secret_detected',
    )
  })

  it('refuses a GitHub token', () => {
    expect(
      classify({ command: `git remote set-url origin https://${GITHUB_PAT}@github.com/x/y` })
        ?.reason,
    ).toBe('security.secret_detected')
    expect(classify({ content: `token: ${GITHUB_PAT}` })?.reason).toBe('security.secret_detected')
  })

  it('refuses a Slack token', () => {
    expect(
      classify({ command: `curl -H "Authorization: Bearer ${SLACK_TOKEN}" https://x` })?.reason,
    ).toBe('security.secret_detected')
  })

  it('refuses a private key header', () => {
    expect(classify({ content: PRIVATE_KEY })?.reason).toBe('security.secret_detected')
  })

  it('finds a secret nested anywhere in the arguments', () => {
    expect(classify({ edits: [{ old_string: 'x', new_string: `KEY=${AWS_KEY}` }] })?.reason).toBe(
      'security.secret_detected',
    )
    expect(classify({ options: { env: { TOKEN: GITHUB_PAT } } })?.reason).toBe(
      'security.secret_detected',
    )
  })

  it('passes ordinary arguments', () => {
    expect(classify({ command: 'pnpm test' })).toBeUndefined()
    expect(classify({ file_path: 'src/index.ts' })).toBeUndefined()
    expect(classify({ content: 'export const KEY = process.env.KEY' })).toBeUndefined()
    expect(classify({ command: 'aws s3 ls' })).toBeUndefined()
    expect(classify({})).toBeUndefined()
  })

  it('names the pattern without ever echoing the value', () => {
    const hit = detectSecret({ command: `--key ${AWS_KEY}` }, Config({}))
    expect(hit?.params).toEqual({ pattern: 'AWS access key' })

    // The refusal is what reaches the model. If the value appeared anywhere in
    // it, the guard would be the leak it exists to prevent.
    const guard = createSecretGuard({
      config: () => Config({}),
      t: () => t,
      state: createWorkflowState(),
      log: () => {},
    })
    return guard(makeExec(`deploy --token ${AWS_KEY}`), allow).then((decision) => {
      expect(decision.kind).toBe('deny')
      if (decision.kind !== 'deny') return
      expect(decision.reason).not.toContain(AWS_KEY)
      expect(decision.reason).not.toContain('A'.repeat(16))
      expect(decision.reason).toContain('AWS access key')
      expect(decision.reason).toContain('credential')
    })
  })

  it('reports the kind of pattern, not the pattern text', () => {
    expect(findSecret(PRIVATE_KEY, { genericHighEntropy: false })).toBe('private key')
    expect(findSecret(GITHUB_PAT, { genericHighEntropy: false })).toBe('GitHub token')
    expect(findSecret(SLACK_TOKEN, { genericHighEntropy: false })).toBe('Slack token')
    expect(findSecret('ordinary prose', { genericHighEntropy: false })).toBeUndefined()
  })

  it('leaves high-entropy detection off unless it is asked for', () => {
    expect(findSecret(RANDOM_TOKEN, { genericHighEntropy: false })).toBeUndefined()
    expect(findSecret(RANDOM_TOKEN, { genericHighEntropy: true })).toBe('high-entropy string')
    expect(detectSecret({ content: RANDOM_TOKEN }, Config({}))).toBeUndefined()
    expect(
      detectSecret(
        { content: RANDOM_TOKEN },
        Config({ secretGuard: { genericHighEntropy: true } }),
      ),
    ).toBeDefined()
  })

  it('scans arrays as well as objects', () => {
    expect(scanForSecret(['ok', GITHUB_PAT], { genericHighEntropy: false })).toBe('GitHub token')
    expect(scanForSecret([['ok', AWS_KEY]], { genericHighEntropy: false })).toBe('AWS access key')
    expect(scanForSecret({ a: [1, true, null] }, { genericHighEntropy: false })).toBeUndefined()
  })

  it('redacts every recognised credential in a copy', () => {
    const redacted = redactSecrets(
      { command: `x ${AWS_KEY}`, nested: [GITHUB_PAT], count: 3 },
      { genericHighEntropy: false },
    )
    expect(redacted).toEqual({ command: 'x [REDACTED]', nested: ['[REDACTED]'], count: 3 })
  })

  it('does not modify the arguments it was handed', () => {
    // The call is about to run: redaction belongs to the record, not the call.
    const args = { command: `x ${AWS_KEY}` }
    redactSecrets(args, { genericHighEntropy: false })
    expect(args.command).toContain(AWS_KEY)
  })

  it('refuses by default rather than asking', async () => {
    const state = createWorkflowState()
    const guard = createSecretGuard({
      config: () => Config({}),
      t: () => t,
      state,
      log: () => {},
    })
    const decision = await guard(makeExec(`deploy --token ${AWS_KEY}`), allow)
    expect(decision.kind).toBe('deny')
    expect(state.guardHits()).toEqual({ 'security.secret_detected': 1 })
  })

  it('lets an ordinary call through and records no hit', async () => {
    const state = createWorkflowState()
    const guard = createSecretGuard({
      config: () => Config({}),
      t: () => t,
      state,
      log: () => {},
    })
    expect(await guard(makeExec('pnpm build'), allow)).toEqual({ kind: 'allow' })
    expect(state.guardHits()).toEqual({})
  })

  it('registers nothing when the guard is disabled', () => {
    const config = Config({ secretGuard: { enabled: false } })
    expect(detectSecret({ content: AWS_KEY }, config)).toBeUndefined()
  })
})
