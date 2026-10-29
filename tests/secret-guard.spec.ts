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
/** A registry token, built to the shape npm issues. */
const NPM_TOKEN = `npm_${'c'.repeat(36)}`
/** The same, for GitLab. */
const GITLAB_PAT = `glpat-${'d'.repeat(20)}`
/** And for a GitHub fine-grained PAT, whose prefix differs from the classic family. */
const FINE_GRAINED_PAT = `github_pat_${'e'.repeat(24)}`
/** Three base64url segments whose header decodes to an opening brace, as a JWT's do. */
const JWT = `eyJ${'f'.repeat(10)}.${'g'.repeat(10)}.${'h'.repeat(10)}`
/** An opaque value handed to an Authorization header. */
const BEARER = `Bearer ${'i'.repeat(24)}`

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

  it('recognises the registry and header shapes as well', () => {
    // The prefixes are what make a shape recognisable without a heuristic: each
    // one is issued by exactly one service, so a match names the service too.
    expect(findSecret(NPM_TOKEN, { genericHighEntropy: false })).toBe('npm token')
    expect(findSecret(GITLAB_PAT, { genericHighEntropy: false })).toBe('GitLab token')
    expect(findSecret(FINE_GRAINED_PAT, { genericHighEntropy: false })).toBe(
      'GitHub fine-grained token',
    )
    expect(findSecret(JWT, { genericHighEntropy: false })).toBe('JWT')
    expect(findSecret(BEARER, { genericHighEntropy: false })).toBe('Bearer token')
    expect(classify({ command: `curl -H "Authorization: ${BEARER}" https://x` })?.params).toEqual({
      pattern: 'Bearer token',
    })
  })

  it('keeps the classes apart, so each shape names its own service', () => {
    // A fine-grained PAT also satisfies the substring a classic one looks for
    // only if the classic rule is read carelessly; order decides which name is
    // reported, and the specific prefix must win.
    expect(findSecret(FINE_GRAINED_PAT, { genericHighEntropy: false })).not.toBe('GitHub token')
    // A Slack token in a header is still a Slack token: the value's own shape
    // is the stronger claim, so the header rule must not take it over.
    expect(findSecret(`Authorization: Bearer ${SLACK_TOKEN}`, { genericHighEntropy: false })).toBe(
      'Slack token',
    )
  })

  it('lets a documented placeholder through, but not a real key beside it', () => {
    // Documentation is the one place a credential-shaped string belongs: AWS's
    // own reference key ends in EXAMPLE, and a tutorial writes YOUR_API_KEY where
    // the value goes. Refusing those teaches a reader to switch the guard off.
    const documentKey = `AKIA${'IOSFODNN7EXAMPLE'}`
    expect(findSecret(documentKey, { genericHighEntropy: false })).toBeUndefined()
    expect(
      findSecret(`Bearer ${'YOUR_API_KEY_YOUR_API_KEY'}`, { genericHighEntropy: false }),
    ).toBeUndefined()
    expect(findSecret(`ghp_${'x'.repeat(24)}`, { genericHighEntropy: false })).toBeUndefined()

    // The exemption is per match, not per string: a page that shows a placeholder
    // and then a real key is still a page that leaks one.
    expect(findSecret(`${documentKey} then ${AWS_KEY}`, { genericHighEntropy: false })).toBe(
      'AWS access key',
    )
  })

  it('recognises the keys of the services that handout a bare prefix', () => {
    // Each of these is issued with a prefix unique enough to name the service,
    // so no entropy heuristic is involved and none of them needs a key name
    // beside it.
    expect(findSecret(`sk-ant-${'j'.repeat(24)}`, { genericHighEntropy: false })).toBe(
      'Anthropic key',
    )
    expect(findSecret(`sk-${'k'.repeat(24)}`, { genericHighEntropy: false })).toBe('OpenAI key')
    expect(findSecret(`sk_live_${'l'.repeat(24)}`, { genericHighEntropy: false })).toBe(
      'Stripe secret key',
    )
    expect(findSecret(`AIza${'m'.repeat(35)}`, { genericHighEntropy: false })).toBe(
      'Google API key',
    )
    expect(
      findSecret(`SG.${'n'.repeat(22)}.${'o'.repeat(22)}`, { genericHighEntropy: false }),
    ).toBe('SendGrid key')
    expect(findSecret(`SK${'0123456789abcdef'.repeat(2)}`, { genericHighEntropy: false })).toBe(
      'Twilio API key',
    )
  })

  it('recognises the shapes that only a key name makes specific', () => {
    // An AWS secret access key has no prefix at all, and a password is a
    // password only because of the word in front of it. Both are read with the
    // name required, so ordinary prose about a password field stays allowed.
    // The alphabet is base64's, and the length is fixed at 40: a shorter run
    // after the name is an id or an explanation, not the secret half.
    expect(
      findSecret('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYzABCDEFGHI', {
        genericHighEntropy: false,
      }),
    ).toBe('AWS secret access key')
    expect(findSecret('password="hunter2hunter2"', { genericHighEntropy: false })).toBe(
      'password assignment',
    )
    expect(
      findSecret(`postgres://user:${'p'.repeat(16)}@db.example.com/app`, {
        genericHighEntropy: false,
      }),
    ).toBe('connection string')
  })

  it('leaves the same words alone when no value follows them', () => {
    expect(findSecret('set the password in the environment', { genericHighEntropy: false })).toBe(
      undefined,
    )
    expect(findSecret('aws_secret_access_key', { genericHighEntropy: false })).toBeUndefined()
    expect(
      findSecret('postgres://db.example.com/app', { genericHighEntropy: false }),
    ).toBeUndefined()
  })

  it('does not treat the word Bearer, or short values, as a credential', () => {
    expect(findSecret('Bearer', { genericHighEntropy: false })).toBeUndefined()
    expect(findSecret('Authorization: Bearer', { genericHighEntropy: false })).toBeUndefined()
    expect(findSecret('Bearer abc123', { genericHighEntropy: false })).toBeUndefined()
    expect(findSecret('npm run build', { genericHighEntropy: false })).toBeUndefined()
    expect(findSecret('glpat-', { genericHighEntropy: false })).toBeUndefined()
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

  it('holds the entropy floor where a token stops looking like prose', () => {
    // The floor is the line between an opaque key and repeated text, so it has
    // to stay between the two: 42 distinct characters sit above it (log2 42 ≈
    // 5.4 bits), and a long run of one character sits at zero.
    const distinct = '0123456789abcdefghijklmnopqrstuvwxyzABCD'
    expect(findSecret(distinct, { genericHighEntropy: true })).toBe('high-entropy string')
    expect(findSecret('a'.repeat(40), { genericHighEntropy: true })).toBeUndefined()
  })

  it('stops scanning a structure that points back at itself', () => {
    // Arguments come from a model, and a cyclic one would otherwise be walked
    // until the stack ran out — inside the guard that runs *before* the call.
    const cyclic: Record<string, unknown> = { ok: 'fine' }
    cyclic.self = cyclic
    expect(scanForSecret(cyclic, { genericHighEntropy: false })).toBeUndefined()
    expect(redactSecrets(cyclic, { genericHighEntropy: false })).toMatchObject({ ok: 'fine' })
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
