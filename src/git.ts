import type { Context } from '@deepseek-ai/cordis'

// The single place this plugin talks to git. Everything routes through the DSH
// subprocess service rather than `node:child_process`, so spawned git inherits
// the harness's scrubbed environment and cancellation policy.

// The service is read through `ctx.get`, not `inject`: git is an optional
// capability, and a profile without a subprocess provider must still load the
// plugin and report "git was not found" for one check rather than fail to mount.
// The types below are the structural shape actually used; `@deepseek-ai/dsh-subprocess`
// is a peer package that cannot be resolved from this plugin's own root.
interface OutputReader {
  readFrom(offset: number): { text: string }
}

interface SpawnOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
}

interface SpawnHandle {
  readonly collected: { readonly stdout?: OutputReader; readonly stderr?: OutputReader }
  readonly done: Promise<SpawnOutcome>
  terminate(): void
}

interface SubprocessService {
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal?: AbortSignal
  }): SpawnHandle
}

/** Why a git call did not produce usable output. */
export type GitFailure =
  /** No subprocess provider is mounted, or git is not on the provider's PATH. */
  | 'git-not-available'
  /** The directory is not inside a git work tree. */
  | 'not-a-git-repository'
  /** The call was cancelled through its abort signal. */
  | 'cancelled'
  /** git ran and reported a failure the caller has to read from `stderr`. */
  | 'command-failed'

/** Outcome of one git invocation. */
export type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly failure: GitFailure; readonly stderr: string }

/** Maximum bytes retained per stream: commit metadata, never file contents. */
const MAX_STREAM_BYTES = 1024 * 1024

/** Grace period handed to the subprocess provider's termination procedure. */
const GRACE_MS = 5000

/**
 * Read the optional subprocess service from a context.
 * @param ctx - any DSH context; the service is resolved, not injected.
 * @returns the service, or `undefined` when the profile has no provider.
 */
function service(ctx: Context): SubprocessService | undefined {
  const found: unknown = ctx.get('subprocess')
  return found === undefined || found === null ? undefined : (found as SubprocessService)
}

/** Run git in one repository directory. */
export interface GitRunner {
  /** Absolute directory every call runs in. */
  readonly cwd: string
  /**
   * Run one git command.
   * @param args - arguments after the program name, never shell-interpreted.
   * @param signal - caller-owned cancellation.
   * @returns stdout on success, or a classified failure.
   */
  run(args: readonly string[], signal?: AbortSignal): Promise<GitResult>
  /**
   * Whether {@link run} can reach git at all. Callers use this to tell "no git
   * here" apart from "git says no".
   * @param signal - caller-owned cancellation.
   * @returns the executable path, or a failure to report.
   */
  locate(
    signal?: AbortSignal,
  ): Promise<{ ok: true; path: string } | { ok: false; failure: GitFailure }>
}

/**
 * Build a git runner for one working directory.
 * @param ctx - the plugin context.
 * @param cwd - the directory git commands run in.
 * @returns the runner.
 */
export function createGitRunner(ctx: Context, cwd: string): GitRunner {
  const subprocess = service(ctx)

  const locate: GitRunner['locate'] = async (signal) => {
    if (subprocess === undefined) return { ok: false, failure: 'git-not-available' }
    try {
      return { ok: true, path: await subprocess.resolveExecutable('git', undefined, signal) }
    } catch {
      return { ok: false, failure: 'git-not-available' }
    }
  }

  const run: GitRunner['run'] = async (args, signal) => {
    const located = await locate(signal)
    if (!located.ok) return { ok: false, failure: located.failure, stderr: '' }

    let handle: SpawnHandle
    try {
      handle = subprocess!.spawn({
        argv: [located.path, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_STREAM_BYTES },
          stderr: { maxBytes: MAX_STREAM_BYTES },
        },
        graceMs: GRACE_MS,
        signal,
      })
    } catch (error) {
      // A pre-aborted signal and an unlaunchable executable both land here.
      return {
        ok: false,
        failure: signal?.aborted === true ? 'cancelled' : 'git-not-available',
        stderr: String(error),
      }
    }

    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''

    if (outcome.exitCode === 0) return { ok: true, stdout }
    if (signal?.aborted === true) return { ok: false, failure: 'cancelled', stderr }
    if (outcome.exitCode === null) return { ok: false, failure: 'cancelled', stderr }
    if (stderr.includes('not a git repository')) {
      return { ok: false, failure: 'not-a-git-repository', stderr }
    }
    return { ok: false, failure: 'command-failed', stderr }
  }

  return { cwd, run, locate }
}
