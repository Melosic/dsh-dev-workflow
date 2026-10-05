import z from '@deepseek-ai/schemastery'

// The plugin reads its own configuration from the DSH profile. This file is the
// single declaration of that surface: every field carries a default, so an empty
// configuration resolves to the documented safe baseline (plugin on, destructive
// git operations ask, nothing allowed implicitly).

/** Commit types from the specification, in the order it lists them. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const

/** Subject length the specification asks for. */
export const SUBJECT_MAX_LENGTH = 50

/**
 * Default commit header pattern, derived from {@link COMMIT_TYPES} so the
 * accepted types and the pattern cannot drift apart.
 */
export const DEFAULT_COMMIT_PATTERN = `^(${COMMIT_TYPES.join('|')})(\\([^)]+\\))?!?: \\S`

/**
 * One destructive-git policy value.
 *
 * `deny` blocks the call, `ask` routes it through the approval prompt, and
 * `allow` lets it run untouched. A factory rather than a shared instance: the
 * schema builder is reused for every policy field and must not share resolved
 * state.
 * @returns a fresh policy schema defaulting to `ask`.
 */
const guardAction = () => z.union(['deny', 'ask', 'allow']).default('ask')

/** Plugin configuration schema, validated by DSH before {@link apply} runs. */
export const Config = z.object({
  /** Prefixes that count as "code" when deciding whether a document is stale. */
  codePaths: z.array(z.string()).default(['src/']),
  /** Where this repository keeps the documents a change is expected to update. */
  docs: z
    .object({
      readme: z.array(z.string()).default(['README.md', 'README.zh.md']),
      changelog: z.string().default('CHANGELOG.md'),
      docsDir: z.string().default('docs/'),
      adrDir: z.string().default('docs/ADR/'),
      /**
       * Files that must change together, listed as one group per line. The
       * repository keeps several such pairs; leaving them in configuration
       * keeps every path out of the check itself.
       */
      mirrors: z.array(z.array(z.string())).default([
        ['README.md', 'README.zh.md'],
        ['locale/en.json', 'locale/zh.json'],
        ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md'],
      ]),
    })
    .default({}),
  /** Mechanical conventions the checks compare a change against. */
  rules: z
    .object({
      branchPattern: z.string().default('^(feature|fix|docs|hotfix|chore)/[a-z0-9][a-z0-9._-]*$'),
      commitPattern: z.string().default(DEFAULT_COMMIT_PATTERN),
      requireChangelogOnFeat: z.boolean().default(true),
    })
    .default({}),
  /** Master switch. `off` registers nothing, so the plugin costs no tokens. */
  mode: z.union(['on', 'off']).default('on'),
  /** Dictionary to translate user-visible text with. `auto` follows the runtime locale. */
  locale: z.union(['auto', 'en-US', 'zh-CN']).default('auto'),
  /**
   * Whether this plugin runs its own pre-commit check. Turn it off when the
   * repository already enforces the same rules with husky and commitlint.
   */
  enableOwnTrigger: z.boolean().default(true),
  /** Policies for git operations that can discard work. */
  gitGuard: z
    .object({
      enabled: z.boolean().default(true),
      forcePush: guardAction(),
      hardReset: guardAction(),
      rebase: guardAction(),
      amend: guardAction(),
      branchDelete: guardAction(),
      /**
       * `git clean -f` deletes untracked files. It has its own policy rather
       * than borrowing the hard-reset one: they discard different things.
       */
      cleanForce: guardAction(),
      /** `git checkout -- .` discards unstaged edits. */
      checkoutDiscard: guardAction(),
      /**
       * `--no-verify` skips the hooks that protect the repository. It defaults
       * to `ask` and never to `deny`: it is the escape hatch for the moment
       * hooks are wrong, and closing it would leave no way through.
       */
      noVerify: guardAction(),
    })
    .default({}),
  /** Policies for shell commands that can destroy a machine rather than a commit. */
  commandGuard: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * One policy for every recognised pattern, because they share one property:
       * none of them can be undone. They differ only in what they destroy.
       */
      dangerousShell: guardAction(),
    })
    .default({}),
})

/** Resolved plugin configuration: every default applied. */
export type Config = Schemastery.TypeT<typeof Config>
