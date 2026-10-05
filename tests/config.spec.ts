import { describe, expect, it } from 'vitest'
import { COMMIT_TYPES, Config, DEFAULT_COMMIT_PATTERN, SUBJECT_MAX_LENGTH } from '../src/config.js'

// The configuration surface: every default the plugin documents, and the
// validation the host performs before `apply` ever runs.

describe('src/config.ts', () => {
  it('resolves an empty configuration to the documented safe baseline', () => {
    const config = Config({})

    expect(config.mode).toBe('on')
    expect(config.locale).toBe('auto')
    expect(config.enableOwnTrigger).toBe(true)
    expect(config.rules.requireChangelogOnFeat).toBe(true)
    expect(config.codePaths).toEqual(['src/'])
  })

  it('defaults every destructive git operation to ask', () => {
    const config = Config({})

    expect(config.gitGuard).toEqual({
      enabled: true,
      forcePush: 'ask',
      hardReset: 'ask',
      rebase: 'ask',
      amend: 'ask',
      branchDelete: 'ask',
      cleanForce: 'ask',
      checkoutDiscard: 'ask',
      noVerify: 'ask',
    })
  })

  it('gives each guard field its own default instead of sharing one', () => {
    // A shared schema instance would leak the first resolved value into every
    // other field; `guardAction()` is a factory precisely to prevent that.
    const config = Config({ gitGuard: { forcePush: 'deny' } })

    expect(config.gitGuard.forcePush).toBe('deny')
    expect(config.gitGuard.hardReset).toBe('ask')
    expect(config.gitGuard.noVerify).toBe('ask')
  })

  it('accepts all three policy values for a guard operation', () => {
    for (const action of ['deny', 'ask', 'allow'] as const) {
      expect(Config({ gitGuard: { rebase: action } }).gitGuard.rebase).toBe(action)
    }
  })

  it('defaults every non-git guard to a safe, enabled baseline', () => {
    const config = Config({})

    expect(config.commandGuard).toEqual({ enabled: true, dangerousShell: 'ask' })
    expect(config.fileGuard).toEqual({
      enabled: true,
      noRead: [
        '.env',
        '.ssh/id_rsa',
        '*.pem',
        '*.key',
        'credentials',
        '*.p12',
        '.npmrc',
        'secrets/',
      ],
    })
    // The high-entropy heuristic is the one rule that flags ordinary text, so it
    // is the one rule that ships off.
    expect(config.secretGuard).toEqual({ enabled: true, genericHighEntropy: false })
    expect(config.audit).toEqual({ enabled: true, path: '.dev-docs/audit-log.jsonl' })
  })

  it('keeps the command policy out of the git guard and vice versa', () => {
    const config = Config({
      commandGuard: { dangerousShell: 'deny' },
      fileGuard: { noRead: ['*.vault'] },
    })

    expect(config.commandGuard.dangerousShell).toBe('deny')
    expect(config.gitGuard.forcePush).toBe('ask')
    expect(config.fileGuard.noRead).toEqual(['*.vault'])
  })

  it('defaults the document layout to this repository', () => {
    const config = Config({})

    expect(config.docs.readme).toEqual(['README.md', 'README.zh.md'])
    expect(config.docs.changelog).toBe('CHANGELOG.md')
    expect(config.docs.docsDir).toBe('docs/')
    expect(config.docs.adrDir).toBe('docs/ADR/')
    expect(config.docs.mirrors).toEqual([
      ['README.md', 'README.zh.md'],
      ['locale/en.json', 'locale/zh.json'],
      ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md'],
    ])
  })

  it('derives the default commit pattern from the accepted types', () => {
    expect(DEFAULT_COMMIT_PATTERN).toBe(`^(${COMMIT_TYPES.join('|')})(\\([^)]+\\))?!?: \\S`)
    expect(COMMIT_TYPES).toHaveLength(11)
    expect(SUBJECT_MAX_LENGTH).toBe(50)
  })

  it('rejects a mode outside on and off', () => {
    expect(() => Config({ mode: 'maybe' })).toThrowError(
      '$.mode expected "on" | "off" but got "maybe"',
    )
  })

  it('rejects a locale it ships no dictionary for', () => {
    expect(() => Config({ locale: 'fr' })).toThrowError(
      '$.locale expected "auto" | "en-US" | "zh-CN" but got "fr"',
    )
  })

  it('rejects an unknown guard policy', () => {
    expect(() => Config({ gitGuard: { forcePush: 'yes' } })).toThrowError(
      '$.gitGuard.forcePush expected "deny" | "ask" | "allow" but got "yes"',
    )
  })

  it('keeps an explicit value and fills the rest with defaults', () => {
    const config = Config({
      mode: 'off',
      locale: 'zh-CN',
      enableOwnTrigger: false,
      codePaths: ['packages/'],
    })

    expect(config.mode).toBe('off')
    expect(config.locale).toBe('zh-CN')
    expect(config.enableOwnTrigger).toBe(false)
    expect(config.codePaths).toEqual(['packages/'])
    expect(config.gitGuard.enabled).toBe(true)
  })
})
