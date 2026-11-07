import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'
import type { GitRunner } from './git.js'
import { matchesPattern } from './guard/file-guard.js'
import { redactSecrets } from './guard/secret-guard.js'
import type { GuardHit } from './guard/shared.js'

// The audit trail is the part of a guard that outlives the session: everything
// else a guard does is a decision the agent sees, and this is the record a
// reviewer reads afterwards. It is written to one JSON object per line under
// `.dev-docs/` by default, and it deliberately never re-enters the model's
// context — nothing here returns a value the agent can read, and the file is
// not a tool the model can call.
//
// Whether git takes that file is the repository's business: a default path is
// not permission to edit somebody's `.gitignore`, so the plugin does not write
// one. It asks git instead, once per path, and says so when the answer is that
// the trail would be committed — a file listing every credential that was
// refused is worse in a commit than no file at all.
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
  /**
   * Called with a log path git would commit, once per path per session.
   *
   * Warning level, because the reader has to act on it: either the path belongs
   * somewhere ignored, or `.gitignore` needs a line. The audit trail never edits
   * that file itself.
   */
  readonly notIgnored?: (path: string) => void
  /**
   * Git runner for a working directory, when the profile has one.
   *
   * Absent means the plugin cannot ask whether the log path is ignored, and it
   * then says nothing rather than guessing.
   */
  readonly git?: (cwd: string) => GitRunner | undefined
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
 * a log could not be written, so a failed write is reported instead. Appending
 * is synchronous on purpose — an audit line that is buffered when the process
 * dies is not a record.
 *
 * A failed write is reported once per session, through the caller's log sink.
 * The caller (`src/index.ts`) binds that sink to the debug logger, so a broken
 * trail costs the model nothing and never turns into a tool failure; the line
 * exists for whoever is reading the debug log. Only the first failure is
 * reported — a sink that keeps failing would otherwise log on every hit for the
 * rest of the session, which is noise, not a record.
 *
 * A trail that git would commit is a different matter and is reported at
 * warning level, once per path: it is not a fault in this plugin, it is a line
 * missing from the repository's `.gitignore`, and only the reader can add it.
 * Asking git costs one subprocess, so the answer is remembered per path and the
 * question is asked after the first write, not before it.
 * @param options - the audit trail's configuration.
 * @returns the sink for {@link GuardOptions.audit}.
 */
export function createAudit(options: AuditOptions): AuditSink {
  let reported = false
  // Paths this session has already asked git about. A path is asked once: the
  // answer changes only when somebody edits `.gitignore`, and a warning repeated
  // on every hit would be the noise the failure sink already avoids.
  const asked = new Set<string>()
  const checkIgnored = (path: string): void => {
    if (asked.has(path)) return
    asked.add(path)
    const runner = options.git?.(dirname(path))
    if (runner === undefined) return
    // `check-ignore` exits 0 when the path is ignored and 1 when it is not; the
    // runner reports a non-zero exit as `command-failed`, so that is the answer
    // that matters. Git missing, or a directory that is no repository at all, is
    // not this plugin's business and says nothing.
    void runner
      .run(['check-ignore', '--quiet', path])
      .then((result) => {
        if (result.ok || result.failure !== 'command-failed') return
        options.notIgnored?.(path)
      })
      // Nothing downstream awaits this probe, so a runner that throws would
      // become an unhandled rejection in somebody's host process.
      .catch(() => undefined)
  }
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
      checkIgnored(path)
    } catch (error) {
      if (reported) return
      reported = true
      options.log?.(`[dsh-dev-workflow] audit write failed: ${String(error)}`)
    }
  }
  const sink = (hit: GuardHit, exec: ToolExecution): void => write(hit, exec)
  sink.settled = (hit: GuardHit, exec: ToolExecution, decision: string) =>
    write(hit, exec, decision)
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
