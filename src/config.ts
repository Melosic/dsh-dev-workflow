import z from '@deepseek-ai/schemastery'

// The plugin reads its own configuration from the DSH profile. This file is the
// single declaration of that surface: every field carries a default, so an empty
// configuration resolves to the documented safe baseline (plugin on, destructive
// git operations ask, nothing allowed implicitly).
//
// Every leaf is also `.volatile()`. That marker is what the settings panel reads:
// the Host only offers the fields declared volatile, and the Loader commits a
// change to one of them into the running references without restarting the
// plugin. A leaf without it still configures the plugin from the profile file,
// but is invisible in the panel. Containers stay plain: the panel rebuilds a
// form from the volatile leaves it finds under them.

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
 * Files whose change normally implies a README update. Used by
 * `docsCheck.requireReadmeOnConfig`.
 */
export const CONFIG_FILES = ['package.json', 'cordis.patch.yml'] as const

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
const guardAction = () => z.union(['deny', 'ask', 'allow']).default('ask').volatile()

/** Plugin configuration schema, validated by DSH before {@link apply} runs. */
export const Config = z.object({
  /** Prefixes that count as "code" when deciding whether a document is stale. */
  codePaths: z.array(z.string()).default(['src/']).volatile(),
  /** Where this repository keeps the documents a change is expected to update. */
  docs: z
    .object({
      readme: z.array(z.string()).default(['README.md', 'README.zh.md']).volatile(),
      changelog: z.string().default('CHANGELOG.md').volatile(),
      docsDir: z.string().default('docs/').volatile(),
      adrDir: z.string().default('docs/ADR/').volatile(),
      /**
       * Files that must change together, listed as one group per line. The
       * repository keeps several such pairs; leaving them in configuration
       * keeps every path out of the check itself.
       */
      mirrors: z
        .array(z.array(z.string()))
        .default([
          ['README.md', 'README.zh.md'],
          ['locale/en.json', 'locale/zh.json'],
          ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md'],
        ])
        .volatile(),
      /**
       * Path prefixes that do not count as a code change even when they sit
       * under {@link codePaths}, so documenting-only trees can opt out of the
       * "code changed, document missing" warning.
       */
      exclude: z.array(z.string()).default([]).volatile(),
    })
    .default({}),
  /** Whether the documentation rules take part in {@link evaluate}. */
  docsCheck: z
    .object({
      /**
       * Turns the documentation rules of the pre-commit evaluation off. The
       * `check_doc_sync` tool is an explicit call and stays available.
       */
      enabled: z.boolean().default(true).volatile(),
      /**
       * Warn when a configuration file changes without a README update. Off by
       * default: the README is not the changelog, and most dependency bumps
       * touch `package.json` without deserving a documentation line.
       */
      requireReadmeOnConfig: z.boolean().default(false).volatile(),
    })
    .default({}),
  /** Mechanical conventions the checks compare a change against. */
  rules: z
    .object({
      branchPattern: z
        .string()
        .default('^(feature|fix|docs|hotfix|chore)/[a-z0-9][a-z0-9._-]*$')
        .volatile(),
      commitPattern: z.string().default(DEFAULT_COMMIT_PATTERN).volatile(),
      requireChangelogOnFeat: z.boolean().default(true).volatile(),
    })
    .default({}),
  /** Whether the commit-message rules take part in {@link evaluate}. */
  commitCheck: z
    .object({
      /** Turns the commit-message rules of the pre-commit evaluation off. */
      enabled: z.boolean().default(true).volatile(),
      /**
       * What a hard commit-message problem does. `warn` demotes the errors to
       * warnings; `block` keeps them blocking. The advisory rules (subject
       * length, trailing period, missing scope) are warnings either way.
       */
      onFailure: z.union(['warn', 'block']).default('block').volatile(),
      /**
       * Types the header may open with. Defaults to {@link COMMIT_TYPES}; a
       * repository that narrowed its convention can say so here.
       */
      types: z
        .array(z.string())
        .default([...COMMIT_TYPES])
        .volatile(),
      /**
       * Require a scope on every header. Off by default, where a missing scope
       * is only an advisory warning when the change touches one module.
       */
      requireScope: z.boolean().default(false).volatile(),
      /** Maximum subject length, measured from the text after `type: `. */
      subjectMaxLength: z.number().step(1).min(1).default(SUBJECT_MAX_LENGTH).volatile(),
    })
    .default({}),
  /** Master switch. `off` registers nothing, so the plugin costs no tokens. */
  mode: z.union(['on', 'off']).default('on').volatile(),
  /** Dictionary to translate user-visible text with. `auto` follows the runtime locale. */
  locale: z.union(['auto', 'en-US', 'zh-CN']).default('auto').volatile(),
  /**
   * Whether this plugin runs its own pre-commit check. Turn it off when the
   * repository already enforces the same rules with husky and commitlint.
   */
  enableOwnTrigger: z.boolean().default(true).volatile(),
  /** Policies for git operations that can discard work. */
  gitGuard: z
    .object({
      enabled: z.boolean().default(true).volatile(),
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
      /**
       * Answer `ask` from the session's own history: once an operation was
       * approved, the same operation is not asked about again. Off by default,
       * because one approval is not consent for the rest of the session. Only
       * `ask` is affected; `deny` always blocks.
       */
      rememberApproved: z.boolean().default(false).volatile(),
    })
    .default({}),
  /** Policies for shell commands that can destroy a machine rather than a commit. */
  commandGuard: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      /**
       * One policy for every recognised pattern, because they share one property:
       * none of them can be undone. They differ only in what they destroy.
       */
      dangerousShell: guardAction(),
    })
    .default({}),
  /** Files and directories the plugin never lets a tool name at all. */
  fileGuard: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      /**
       * Patterns matched against a tool's path arguments and against the words of
       * a shell command. A trailing `/` matches that directory and everything
       * under it; a pattern containing `/` also matches at any depth
       * (`.ssh/id_rsa` matches `~/.ssh/id_rsa`); anything else matches the file
       * name, where a leading dot also covers its variants (`.env` covers
       * `.env.local`).
       */
      noRead: z
        .array(z.string())
        .default([
          '.env',
          '.ssh/id_rsa',
          '*.pem',
          '*.key',
          'credentials',
          '*.p12',
          '.npmrc',
          'secrets/',
        ])
        .volatile(),
    })
    .default({}),
  /** Credential patterns scanned for in every tool argument. */
  secretGuard: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      /**
       * Also flag long high-entropy strings with no known prefix. Off by default:
       * it is the pattern most likely to stop an ordinary call.
       */
      genericHighEntropy: z.boolean().default(false).volatile(),
    })
    .default({}),
  /** Security audit trail. */
  audit: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      /** One JSON object per line. Kept out of version control by `.dev-docs/`. */
      path: z.string().default('.dev-docs/audit-log.jsonl').volatile(),
    })
    .default({}),
})

/** Resolved plugin configuration: every default applied. */
export type Config = Schemastery.TypeT<typeof Config>
