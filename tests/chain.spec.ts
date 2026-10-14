import { describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { GitResult, GitRunner } from '../src/git.js'
import { createTranslator } from '../src/i18n.js'
import { Config } from '../src/config.js'
import { createRuntime } from '../src/index.js'
import { createHarness, askOf, makeExec } from './harness.js'

// The guards and the convention triggers ride on the same event, in one
// waterfall, and the order between them is not the order they were written in:
// the outermost listener's answer is the one the tool call settles on. Every
// other spec drives one listener with `next()` answering `allow`, which is a
// shape no session ever produces. These cases drive the chain the runtime
// actually registers, because that is where the audit's worst findings lived:
// a guard that answers `ask` first would hide every convention finding behind
// its own generic question.

const t = createTranslator('en-US')

/**
 * A git runner that answers the three questions the checks ask.
 * @param options - staged paths, working-tree paths, and the current message.
 * @returns the runner, recording every argument list it was asked for.
 */
function makeRepo(options: {
  staged?: readonly string[]
  worktree?: readonly string[]
  asks?: string[][]
}): GitRunner {
  const staged = options.staged ?? []
  const worktree = options.worktree ?? staged
  return {
    cwd: process.cwd(),
    run: async (args): Promise<GitResult> => {
      options.asks?.push([...args])
      const joined = args.join(' ')
      if (joined.startsWith('diff --cached')) {
        return { ok: true, stdout: staged.map((path) => `${path}\0`).join('') }
      }
      if (joined.startsWith('status --porcelain')) {
        return { ok: true, stdout: worktree.map((path) => ` M ${path}\n`).join('') }
      }
      if (joined.startsWith('log -1')) return { ok: true, stdout: 'feat: previous subject\n' }
      return { ok: true, stdout: '' }
    },
    locate: async () => ({ ok: true, path: 'git' }),
  }
}

/**
 * Build the chain the runtime registers and drive one command through it.
 * @param command - the shell command to run.
 * @param options - repository contents and configuration overrides.
 * @returns the decision and the captured environment.
 */
async function run(
  command: string,
  options: {
    staged?: readonly string[]
    worktree?: readonly string[]
    config?: Record<string, unknown>
  } = {},
): Promise<{
  decision: PreToolDecision
  asks: string[][]
  harness: ReturnType<typeof createHarness>
}> {
  const harness = createHarness()
  const asks: string[][] = []
  const repo = makeRepo({ ...options, asks })
  // `en-US` explicitly: the prompts are bilingual, the model-facing reason is
  // not, and a runtime reading the machine's locale would assert differently on
  // a different machine.
  const runtime = createRuntime(harness.ctx, Config({ locale: 'en-US', ...options.config }))
  // The runtime builds its own runner per working directory, so the spec asks it
  // once for the directory the call runs in — that answer is the cache entry the
  // triggers will read — and then hands back its own repository for every
  // directory. Running against the real checkout is what the suite must never do.
  const realGit = runtime.git.bind(runtime)
  runtime.git(process.cwd())
  runtime.git = (cwd) => {
    console.log('GITASK', JSON.stringify(cwd), realGit.name)
    return repo
  }
  const exec = makeExec(command)

  // `harness.listeners` is in registration order, outermost first — the same
  // order cordis runs them in.
  const listeners = harness.listeners
  const step = async (index: number): Promise<PreToolDecision> => {
    const next = listeners[index]
    if (next === undefined) return { kind: 'allow' }
    return next.listener(exec as never, (() => step(index + 1)) as never)
  }
  return { decision: await step(0), asks, harness }
}

describe('guard and trigger on one chain', () => {
  it('shows the pull-request findings even though the outward guard asks first', async () => {
    const { decision } = await run(
      'gh pr create --title "Add the thing" --body "No sections here."',
    )

    expect(decision.kind).toBe('ask')
    const ask = askOf(decision)
    // The guard's own question, and the trigger's findings inside it: this is the
    // audit's first finding, and it is only visible on a real chain.
    expect(ask.reason).toContain(t('security.guard.outward_pull_request'))
    expect(ask.reason).toContain(t('tool.check_commit_message.error.missing_type'))
    expect(ask.displayReason.en).toContain(t('tool.check_commit_message.error.missing_type'))
  })

  it('reads a clustered short option, so `git commit -am` still gets its message checked', async () => {
    const { decision, asks } = await run('git commit -am "Add the thing"', {
      staged: ['src/a.ts'],
    })

    expect(decision.kind).toBe('ask')
    expect(askOf(decision).reason).toContain(t('tool.check_commit_message.error.missing_type'))
    // One git call for the staged set, one for the working tree — the checks do
    // not re-read the same answer.
    expect(asks.filter((args) => args[0] === 'status')).toHaveLength(1)
  })

  it('does not block an unrelated commit on a half-staged mirrored pair', async () => {
    // README.md was left half-edited in the working tree; the commit itself is
    // about one source file and its own documentation.
    const { decision } = await run('git commit -m "docs(api): describe the flag"', {
      staged: ['src/a.ts', 'docs/API.md'],
      worktree: ['src/a.ts', 'docs/API.md', 'README.md'],
    })

    expect(decision.kind).toBe('allow')
  })

  it('still refuses a commit that leaves the pair behind entirely', async () => {
    // README.md is the mirror of README.zh.md, and the commit touches only one
    // half of the pair — with nothing else in the tree to suggest the other half
    // is being written next.
    const { decision } = await run('git commit -m "docs(readme): describe the flag"', {
      staged: ['README.md', 'docs/API.md'],
      worktree: ['README.md', 'docs/API.md'],
    })

    expect(decision.kind).toBe('ask')
    // The reason wraps the findings: it names why the call was stopped, then
    // lists what the check found.
    const ask = askOf(decision)
    expect(ask.reason).toContain(t('trigger.pre_commit.reason').split('\n')[0] ?? '')
    expect(ask.reason).toContain(
      createTranslator('en-US')('tool.check_doc_sync.error.mirror', {
        changed: 'README.md',
        missing: 'README.zh.md',
      }),
    )
  })
})
