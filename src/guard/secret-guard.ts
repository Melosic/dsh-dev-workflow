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
  // Registry tokens: npm's `npm_` prefix (36 base62 characters) and GitLab's
  // `glpat-`.
  { id: 'npm token', source: '\\bnpm_[A-Za-z0-9]{36}\\b' },
  { id: 'GitLab token', source: '\\bglpat-[A-Za-z0-9_-]{20,}\\b' },
  // Fine-grained PATs carry their own prefix rather than the `ghp_` family.
  { id: 'GitHub fine-grained token', source: '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b' },
  // A JWT is three base64url segments, the first of which starts with the
  // encoded `{"` header.
  {
    id: 'JWT',
    source: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
  },
  // Anthropic's key carries a longer prefix than OpenAI's, so it is listed
  // first: the generic `sk-` rule would otherwise report the wrong service.
  { id: 'Anthropic key', source: '\\bsk-ant-[A-Za-z0-9_-]{20,}' },
  // OpenAI-style project and user keys, and the bare `sk-` form the older ones
  // use. The 20-character floor keeps `sk-learn` and `sk-type` out.
  { id: 'OpenAI key', source: '\\bsk-[A-Za-z0-9_-]{20,}' },
  // Stripe's live keys. Underscore-separated, so the `sk-` rule cannot claim
  // them; `test` keys are deliberately not listed, they guard no money.
  { id: 'Stripe secret key', source: '\\b(?:sk|rk)_live_[A-Za-z0-9]{16,}' },
  // Google API keys are a fixed prefix and a fixed-length body.
  { id: 'Google API key', source: '\\bAIza[0-9A-Za-z_-]{35}' },
  // SendGrid issues `SG.<22>.<22>`.
  { id: 'SendGrid key', source: '\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}\\b' },
  // Twilio API keys are `SK` and 32 lowercase hex characters.
  { id: 'Twilio API key', source: '\\bSK[0-9a-f]{32}\\b' },
  // The secret half of an AWS key pair, which is what gets written into a
  // profile with its name beside it and travels without its own prefix.
  {
    id: 'AWS secret access key',
    source: '\\baws_secret_access_key\\s*[=:]\\s*[\'"]?[A-Za-z0-9/+=]{40}\\b',
  },
  // A password written next to its name. The value has to be quoted: an
  // unquoted rule reads `password: string` in a type declaration and
  // `password = getPassword()` in ordinary code as credentials, and a guard
  // that refuses those is a guard that gets switched off. ponytail: quoted
  // values only; unquoted dotenv assignments (`DB_PASSWORD=...`) are left to
  // the file guard, which already refuses the `.env` file itself.
  {
    id: 'password assignment',
    source: '\\b(?:password|passwd|pwd)\\s*[=:]\\s*([\'"])[^\'"\\n]{6,}\\1',
  },
  // A connection string with the password inline, which is how a database or
  // broker URL leaks it: `postgres://user:pass@host/db`.
  { id: 'connection string', source: '\\b[a-z][a-z0-9+.-]*://[^\\s:@/]+:[^\\s@/]+@' },
  // A long opaque value handed to an `Authorization` header. The 20-character
  // floor is what keeps this off ordinary prose that merely says "Bearer".
  { id: 'Bearer token', source: '\\bBearer[ \\t]+[A-Za-z0-9._~+/=-]{20,}' },
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
 * One compiled expression per pattern, global so it can be walked for every
 * occurrence. Both the scan and the redaction read this list: the scan runs on
 * every call, and compiling `SECRET_PATTERNS` twice would only let the two
 * halves drift.
 */
const PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, 'g'),
)

/**
 * The shapes documentation uses for a key that must not work.
 *
 * Docs are the one place a credential-shaped string is legitimate: AWS's own
 * reference key ends in `EXAMPLE`, a tutorial writes `YOUR_API_KEY` or a run of
 * `x` where the real value goes, and a redacted log line says `[REDACTED]`.
 * Refusing those teaches a reader that this guard fires on prose, which is how a
 * deny-only guard gets switched off. The exemption is safe in the direction that
 * matters: these are values a service would never issue, not merely values that
 * look unlikely.
 */
const PLACEHOLDER = /EXAMPLE|X{4,}|\bYOUR[_-][A-Z0-9]{3,}|0{8,}|\[REDACTED\]/i

/**
 * Whether a match is the placeholder a document shows rather than a credential.
 * @param matched - the matched text.
 * @returns whether it can be let through.
 */
function isPlaceholder(matched: string): boolean {
  return PLACEHOLDER.test(matched)
}

/**
 * Find the first credential in a string.
 * @param value - one string from the arguments.
 * @param options - which rules are in force.
 * @returns the pattern name that matched, or `undefined`.
 */
export function findSecret(value: string, options: ScanOptions): string | undefined {
  for (const [index, pattern] of SECRET_PATTERNS.entries()) {
    const expression = PATTERNS[index] as RegExp
    // Every occurrence is inspected, not just the first: a page that shows a
    // placeholder beside a real key must still be refused for the real one.
    expression.lastIndex = 0
    for (const match of value.matchAll(expression)) {
      if (!isPlaceholder(match[0])) return pattern.id
    }
  }
  return options.genericHighEntropy && hasHighEntropyToken(value)
    ? 'high-entropy string'
    : undefined
}

/**
 * How deep a walk follows nested arguments.
 *
 * Arguments are JSON, so a value that nests this far is not a tool call anyone
 * wrote; it is either a cycle (which JSON cannot express, and the copies below
 * would recurse forever on) or a payload built to make this walk expensive.
 * Beyond the floor the value is not inspected, which costs a secret hidden 32
 * levels down and buys back the stack.
 */
const MAX_SCAN_DEPTH = 32

/**
 * Walk any argument value and find the first credential in it.
 * @param value - any part of a tool call's arguments.
 * @param options - which rules are in force.
 * @param depth - how many levels up the walk already is.
 * @returns the pattern name that matched, or `undefined`.
 */
export function scanForSecret(value: unknown, options: ScanOptions, depth = 0): string | undefined {
  if (typeof value === 'string') return findSecret(value, options)
  if (depth >= MAX_SCAN_DEPTH) return undefined
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = scanForSecret(entry, options, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) {
      const found = scanForSecret(entry, options, depth + 1)
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
  for (const expression of PATTERNS) result = result.replace(expression, REDACTED)
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
export function redactSecrets(value: unknown, options: ScanOptions, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, options)
  // Same ceiling as the scan: the record does not need a value nobody could
  // write, and copying one is how a hostile payload turns into a stack overflow.
  if (depth >= MAX_SCAN_DEPTH) return REDACTED
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, options, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = redactSecrets(entry, options, depth + 1)
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
  if (!config.secretGuard.enabled.get()) return undefined
  const pattern = scanForSecret(args, {
    genericHighEntropy: config.secretGuard.genericHighEntropy.get(),
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
