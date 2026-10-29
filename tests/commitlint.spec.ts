import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// `commitlint.config.mjs` exempts dependabot's own commits from
// `body-max-line-length`. Dependabot writes one line per release/commits URL and
// no human is at the keyboard to wrap it, so the rule would fail every bump.
//
// The exemption has to be scoped by authorship, not by width: widening
// `body-max-line-length` for everyone would also legalise a hand-written wall of
// text, which is what the rule exists to prevent. Both directions are pinned
// here, because a config that exempts nothing and a config that exempts
// everything both look "green" from the happy path alone.

const LONG_LINE = 'x'.repeat(140)

/**
 * Run the repository's commitlint on one message.
 *
 * `execFileSync` with `input` rather than a shell pipe: the message is bulk
 * text, and quoting it into a command string is how the line breaks and the
 * brackets in the dependabot trailer get mangled.
 * @param message - the full commit message, trailer included.
 * @returns the exit status commitlint reported.
 */
function lint(message: string): number {
  try {
    execFileSync('pnpm', ['exec', 'commitlint'], {
      input: message,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? 1
  }
}

const DEPENDABOT_BODY = [
  'chore(deps): bump the actions group with 2 updates',
  '',
  `Bumps the actions group with 2 updates: ${LONG_LINE}`,
  '',
  'Signed-off-by: dependabot[bot] <support@github.com>',
  '',
].join('\n')

const HANDWRITTEN_BODY = [
  'docs: explain what the release gate does',
  '',
  `A hand-written paragraph that runs on for ${LONG_LINE}`,
  '',
].join('\n')

describe('commitlint configuration', () => {
  it('lets a dependabot commit through, wide body and all', () => {
    expect(lint(DEPENDABOT_BODY)).toBe(0)
  })

  it('still rejects an over-wide body written by a person', () => {
    // The pair matters: without this half, the config could be exempting
    // everything and the first test would still pass.
    expect(lint(HANDWRITTEN_BODY)).not.toBe(0)
  })

  it('rejects the same body when only the trailer is missing', () => {
    // The subject alone is not authorship proof — another bot, or a person,
    // could produce it. The trailer is what dependabot signs its message with.
    const unsigned = DEPENDABOT_BODY.replace(/Signed-off-by:.*\n/, '')
    expect(lint(unsigned)).not.toBe(0)
  })
})
