import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { auditRecord, createAudit } from '../src/audit.js'
import type { GuardHit } from '../src/guard/shared.js'
import { makeExec } from './harness.js'

// The audit trail is what a reviewer reads after the fact, so the tests here are
// about what it must *not* contain: a live credential, a sensitive file's
// contents, or a sensitive file's directory. What it must contain is the shape of
// the decision, which is what makes it useful.

const HIT: GuardHit = {
  reason: 'security.secret_detected',
  action: 'deny',
  suggestion: 'security.secret_pattern_matched',
  params: { pattern: 'AWS access key' },
}

/** A syntactically valid AWS key, assembled so this file holds no real one. */
const AWS_KEY = `AKIA${'C'.repeat(16)}`

let root: string
let logPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  logPath = join(root, 'audit-log.jsonl')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * The single line written so far, as an object.
 * @returns the parsed record.
 */
function written(): Record<string, unknown> {
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
}

describe('src/audit.ts', () => {
  it('records the decision rather than the material', () => {
    const exec = makeExec(`deploy --token ${AWS_KEY}`, { cwd: root, sessionId: 'session-7' })
    const record = auditRecord(HIT, exec, Config({}))
    expect(record.tool).toBe('bash')
    expect(record.reason).toBe('security.secret_detected')
    expect(record.action).toBe('deny')
    expect(record.session).toBe('session-7')
    expect(record.cwd).toBe(root)
    // The arguments are kept because they say *what* was attempted, with the
    // credential itself replaced.
    expect(JSON.stringify(record.arguments)).not.toContain(AWS_KEY)
    expect(JSON.stringify(record.arguments)).toContain('[REDACTED]')
  })

  it('keeps a sensitive file name and nothing around it', () => {
    const exec = makeExec('', {
      tool: 'read',
      arguments: { file_path: '/repo/inner/.env' },
      cwd: root,
    })
    const record = auditRecord(
      { reason: 'security.sensitive_file_blocked', action: 'deny', params: { file: '.env' } },
      exec,
      Config({}),
    )
    const arguments_ = record.arguments as { file_path: string }
    expect(arguments_.file_path).toBe('.env')
    expect(JSON.stringify(record)).not.toContain('/repo/inner')
  })

  it('does not carry a sensitive file contents into the record', () => {
    // A write whose *content* is the secret: both rules have to hold at once.
    const exec = makeExec('', {
      tool: 'write',
      arguments: { file_path: '/repo/.env', content: `AWS_SECRET_ACCESS_KEY=${AWS_KEY}` },
      cwd: root,
    })
    const record = auditRecord(HIT, exec, Config({}))
    const serialised = JSON.stringify(record)
    expect(serialised).not.toContain(AWS_KEY)
    expect(serialised).toContain('[REDACTED]')
    expect((record.arguments as { file_path: string }).file_path).toBe('.env')
  })

  it('appends one JSON object per line', () => {
    const audit = createAudit({ config: () => Config({ audit: { path: logPath } }) })
    const exec = makeExec(`x ${AWS_KEY}`, { cwd: root })
    audit(HIT, exec)
    const record = written()
    expect(record.reason).toBe('security.secret_detected')
    expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('resolves a relative path against the call working directory', () => {
    const audit = createAudit({
      config: () => Config({ audit: { path: '.dev-docs/audit-log.jsonl' } }),
    })
    audit(HIT, makeExec('pnpm test', { cwd: root }))
    const record = JSON.parse(
      readFileSync(join(root, '.dev-docs/audit-log.jsonl'), 'utf8').trim(),
    ) as Record<string, unknown>
    expect(record.tool).toBe('bash')
  })

  it('writes nothing when the audit trail is switched off', () => {
    const audit = createAudit({
      config: () => Config({ audit: { enabled: false, path: logPath } }),
    })
    audit(HIT, makeExec('pnpm test', { cwd: root }))
    expect(() => readFileSync(logPath, 'utf8')).toThrow()
  })

  it('returns nothing to the model', () => {
    const audit = createAudit({ config: () => Config({ audit: { path: logPath } }) })
    // The sink is called from inside the gate, not from a tool: whatever it
    // returned would be invisible anyway, and it must stay that way.
    expect(audit(HIT, makeExec('pnpm test', { cwd: root }))).toBeUndefined()
  })

  it('reports a failed write instead of failing the call', () => {
    // A file where the directory should be: the append cannot land.
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const messages: string[] = []
    const audit = createAudit({
      config: () => Config({ audit: { path: join(blocker, 'audit-log.jsonl') } }),
      log: (message) => messages.push(message),
    })
    expect(() => audit(HIT, makeExec('pnpm test', { cwd: root }))).not.toThrow()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('audit write failed')
  })
})
