import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'
import { matchesPattern } from './guard/file-guard.js'
import { redactSecrets } from './guard/secret-guard.js'
import type { GuardHit } from './guard/shared.js'

// The audit trail is the part of a guard that outlives the session: everything
// else a guard does is a decision the agent sees, and this is the record a
// reviewer reads afterwards. It is written to one JSON object per line under
// `.dev-docs/`, which `.gitignore` already ignores, and it deliberately never
// re-enters the model's context — nothing here returns a value the agent can
// read, and the file is not a tool the model can call.
//
// What is recorded is the *shape* of what happened: which guard recognised what,
// under which policy, and the arguments with every credential and every
// sensitive path stripped out. A leaked token is not made safe by being written
// to a log instead of sent to a model.

/** Fields shared by every audit line. */
export interface AuditRecord {
  /** ISO-8601 instant the guard fired. */
  readonly time: string
  /** Session the call belongs to, when the dispatcher supplied an agent. */
  readonly session?: string
  /** The tool call's own id, when the dispatcher supplied one. */
  readonly callId?: string
  /** Tool the call would have used. */
  readonly tool: string
  /** Dictionary key naming what the guard recognised. */
  readonly reason: string
  /** The policy that was applied. */
  readonly action: string
  /**
   * What the call actually settled as, written when the decision was made.
   *
   * {@link AuditRecord.action} is the configured tier — what the guard would do
   * on its own. The two differ whenever another gate is stricter, the user
   * answers a question, or the policy is `allow`: a reader asking "did this
   * push happen?" needs this field, not the other one.
   */
  readonly decision?: string
  /** Working directory the call was made from. */
  readonly cwd?: string
  /** The call's arguments, with credentials and sensitive paths removed. */
  readonly arguments: unknown
}

/** What the audit trail needs. */
export interface AuditOptions {
  /** Resolved plugin configuration, read per event. */
  readonly config: () => Config
  /** Diagnostic sink for a write that did not land. Debug level. */
  readonly log?: (message: string) => void
}

/**
 * The audit trail: one sink per guard, plus what it has to report about itself.
 */
export interface AuditSink {
  /**
   * Record one recognised operation.
   * @param hit - what the guard recognised.
   * @param exec - the call the agent is about to make.
   */
  (hit: GuardHit, exec: ToolExecution): void
  /**
   * Write the decision a hit settled as, as its own line.
   * @param hit - what the guard recognised.
   * @param exec - the call the agent is about to make.
   * @param decision - the kind of decision the waterfall returned.
   */
  settled(hit: GuardHit, exec: ToolExecution, decision: string): void
  /** How many writes have failed since the plugin loaded. */
  failures(): number
}

/**
 * The last path component of a path.
 * @param path - a path as written.
 * @returns the file or directory name.
 */
function basename(path: string): string {
  return (
    path
      .replace(/\\/g, '/')
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? path
  )
}

/**
 * Replace every path segment that names a protected file with its base name.
 *
 * A sensitive path is worth recording — the record should say which rule fired —
 * but the directory it sits in is not. The replacement is per word rather than
 * per whole argument, so `cat /repo/.env && make x` records `cat .env && make x`
 * instead of handing the repository's layout to the log. A word arrives wrapped
 * in whatever quoting the command line used, so the quotes are peeled before the
 * match and put back on the replacement.
 * @param value - any part of a tool call's arguments.
 * @param patterns - `fileGuard.noRead`.
 * @returns the value with sensitive path segments reduced to names.
 */
function basenameSensitive(value: unknown, patterns: readonly string[]): unknown {
  if (typeof value === 'string') {
    return value
      .split(/(\s+)/)
      .map((part) => {
        const quoted = part.length > 1 && /^['"]/.test(part) && part.endsWith(part[0] ?? '')
        const bare = quoted ? part.slice(1, -1) : part
        if (!patterns.some((pattern) => matchesPattern(bare, pattern))) return part
        return quoted ? `${part[0] ?? ''}${basename(bare)}${part[0] ?? ''}` : basename(bare)
      })
      .join('')
  }
  if (Array.isArray(value)) return value.map((entry) => basenameSensitive(entry, patterns))
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = basenameSensitive(entry, patterns)
    }
    return copy
  }
  return value
}

/**
 * Turn one call into the line that will be written.
 * @param hit - what the guard recognised.
 * @param exec - the call the agent is about to make.
 * @param config - resolved plugin configuration.
 * @returns the record to serialise.
 */
export function auditRecord(
  hit: GuardHit,
  exec: ToolExecution,
  config: Config,
  decision?: string,
): AuditRecord {
  const agent = exec.agent
  const cwd = agent?.session.header.cwd
  const cleaned = basenameSensitive(
    redactSecrets(exec.arguments, {
      genericHighEntropy: config.secretGuard.genericHighEntropy.get(),
    }),
    config.fileGuard.noRead.get(),
  )
  return {
    time: new Date().toISOString(),
    ...(agent === undefined ? {} : { session: String(agent.session.id) }),
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    tool: exec.name,
    reason: hit.reason,
    action: hit.action,
    ...(decision === undefined ? {} : { decision }),
    ...(cwd === undefined ? {} : { cwd }),
    arguments: cleaned,
  }
}

/**
 * Build the audit sink handed to every guard.
 *
 * The returned function never throws: a guard must not fail a tool call because
 * a log could not be written, so a failed write is reported and counted instead.
 * Appending is synchronous on purpose — an audit line that is buffered when the
 * process dies is not a record.
 *
 * A write that fails stays visible: the first failure is reported at warning
 * level rather than debug, because a silent audit trail is worse than none at
 * all — the reader would take an empty log for a quiet session. The count is
 * what `/dev-workflow status` reports.
 * @param options - the audit trail's configuration.
 * @returns the sink for {@link GuardOptions.audit}.
 */
export function createAudit(options: AuditOptions): AuditSink {
  let failures = 0
  const write = (hit: GuardHit, exec: ToolExecution, decision?: string): void => {
    try {
      const config = options.config()
      if (!config.audit.enabled.get()) return
      const record = auditRecord(hit, exec, config, decision)
      const path =
        record.cwd === undefined
          ? config.audit.path.get()
          : resolveWithin(record.cwd, config.audit.path.get())
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      failures += 1
      const level = failures === 1 ? 'warning' : 'debug'
      options.log?.(`[dsh-dev-workflow] audit write failed (${level}): ${String(error)}`)
    }
  }
  const sink = (hit: GuardHit, exec: ToolExecution): void => write(hit, exec)
  sink.settled = (hit: GuardHit, exec: ToolExecution, decision: string) =>
    write(hit, exec, decision)
  sink.failures = () => failures
  return sink
}

/**
 * Resolve the configured log path against the session's working directory, so a
 * relative `audit.path` lands in the repository the call is being made from.
 * @param cwd - the session's working directory.
 * @param path - the configured path.
 * @returns the path to append to.
 */
function resolveWithin(cwd: string, path: string): string {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : `${root}/${path}`
}
