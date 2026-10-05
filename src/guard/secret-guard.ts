import type { Config } from '../config.js'
import { createGuard } from './shared.js'
import type { GuardAction, GuardHit, GuardOptions } from './shared.js'

// The secret guard is the one guard that reads every call rather than a known
// one: a credential is just as leaked by writing it into a source file as by
// typing it into a shell command. It walks the arguments, matches the shapes
// credentials actually ship in, and refuses the call with a message that names
// the *kind* of pattern and never the value it matched — an error message that
// echoes a live token has published it just as effectively as sending it.
//
// The policy is fixed at `deny` and is not configurable, unlike the git and
// command guards: those protect work that can be recreated, and a deliberate
// override is a reasonable thing to want. A credential that has been sent cannot
// be recalled, so there is no tier below refusal.

/** Options the secret guard needs; the shared ones, unchanged. */
export type SecretGuardOptions = GuardOptions

/** The one policy this guard applies: a credential is never forwarded. */
const ACTION: GuardAction = 'deny'

/** Dictionary key naming the refusal, without the value that caused it. */
const DETECTED = 'security.secret_detected'
/** Dictionary key naming the kind of pattern that matched, via `{pattern}`. */
const PATTERN_NAMED = 'security.secret_pattern_matched'

/** Whether the optional high-entropy heuristic is wanted. */
export interface ScanOptions {
  /**
   * Also flag long random-looking strings with no known prefix. Off by default:
   * it is the rule most likely to stop an ordinary call.
   */
  readonly genericHighEntropy: boolean
}

/**
 * One credential shape.
 *
 * `id` is a language-neutral technical name, interpolated into a translated
 * sentence rather than being translated itself: it names the kind of pattern, so
 * a reader can tell an AWS key from a private key.
 */
interface SecretPattern {
  readonly id: string
  /** Regular-expression source, shared by the scan and the redaction. */
  readonly source: string
}

/** Credential shapes that are recognised unconditionally. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'AWS access key', source: '\\bAKIA[0-9A-Z]{16}\\b' },
  // Classic and fine-grained tokens: ghp_ (PAT), gho_ (OAuth), ghs_ (server),
  // ghr_ (refresh).
  { id: 'GitHub token', source: '\\bgh[pors]_[A-Za-z0-9]{16,}\\b' },
  { id: 'Slack token', source: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b' },
  { id: 'private key', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
]

/** A run of characters that could be one opaque token. */
const TOKEN_RUN = /[A-Za-z0-9+/=_-]{32,}/g

/** Minimum bits per character before a run counts as random rather than prose. */
const ENTROPY_FLOOR = 3.5

/**
 * Shannon entropy of a string, in bits per character.
 * @param value - the candidate token.
 * @returns the entropy; English prose sits near 3, base64 keys above 4.
 */
function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let total = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    total -= probability * Math.log2(probability)
  }
  return total
}

/**
 * The high-entropy heuristic, applied only when it is switched on.
 * @param value - one string from the arguments.
 * @returns whether it carries a random-looking token.
 */
function hasHighEntropyToken(value: string): boolean {
  for (const run of value.match(TOKEN_RUN) ?? []) {
    if (entropy(run) >= ENTROPY_FLOOR) return true
  }
  return false
}

/**
 * Find the first credential in a string.
 * @param value - one string from the arguments.
 * @param options - which rules are in force.
 * @returns the pattern name that matched, or `undefined`.
 */
export function findSecret(value: string, options: ScanOptions): string | undefined {
  for (const pattern of SECRET_PATTERNS) {
    if (new RegExp(pattern.source).test(value)) return pattern.id
  }
  return options.genericHighEntropy && hasHighEntropyToken(value)
    ? 'high-entropy string'
    : undefined
}

/**
 * Walk any argument value and find the first credential in it.
 * @param value - any part of a tool call's arguments.
 * @param options - which rules are in force.
 * @returns the pattern name that matched, or `undefined`.
 */
export function scanForSecret(value: unknown, options: ScanOptions): string | undefined {
  if (typeof value === 'string') return findSecret(value, options)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = scanForSecret(entry, options)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) {
      const found = scanForSecret(entry, options)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** What a redacted string is replaced with. */
export const REDACTED = '[REDACTED]'

/**
 * Replace every recognised credential inside one string.
 * @param value - the string to clean.
 * @param options - which rules are in force.
 * @returns the string with matches replaced.
 */
function redactText(value: string, options: ScanOptions): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, 'g'), REDACTED)
  }
  if (options.genericHighEntropy) {
    result = result.replace(TOKEN_RUN, (run) => (entropy(run) >= ENTROPY_FLOOR ? REDACTED : run))
  }
  return result
}

/**
 * Deep-copy a value, replacing credentials with {@link REDACTED}.
 *
 * Copies rather than mutates: this runs against the live arguments of a call the
 * tool is still about to run, and redaction is for the record, not the call.
 * @param value - any part of a tool call's arguments.
 * @param options - which rules are in force.
 * @returns the redacted copy.
 */
export function redactSecrets(value: unknown, options: ScanOptions): unknown {
  if (typeof value === 'string') return redactText(value, options)
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, options))
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = redactSecrets(entry, options)
    }
    return copy
  }
  return value
}

/**
 * Classify one call.
 * @param args - the call's arguments, of any shape.
 * @param config - resolved plugin configuration.
 * @returns the refusal, or `undefined` for an ordinary call.
 */
export function detectSecret(args: unknown, config: Config): GuardHit | undefined {
  if (!config.secretGuard.enabled) return undefined
  const pattern = scanForSecret(args, {
    genericHighEntropy: config.secretGuard.genericHighEntropy,
  })
  if (pattern === undefined) return undefined
  // `params` carries the pattern *name* only. The value that matched is not put
  // here, not put in the reason, and not put in the audit record.
  return { reason: DETECTED, action: ACTION, suggestion: PATTERN_NAMED, params: { pattern } }
}

/**
 * Build the `tools/pre-execute` listener for the secret guard.
 * @param options - the shared guard options.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createSecretGuard(options: SecretGuardOptions): ReturnType<typeof createGuard> {
  return createGuard({
    ...options,
    label: 'secret guard',
    detect: (exec) => detectSecret(exec.arguments, options.config()),
  })
}
