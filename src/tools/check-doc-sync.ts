import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { Translate } from '../i18n.js'
import type { GitRunner } from '../git.js'
import type { CheckResult } from './result.js'
import { renderCheck } from './result.js'

// Documentation sync. Only two things here are mechanical enough to block a
// change: a paired file that was left behind, and a repository-wide rule. "This
// code change ought to be described in ARCHITECTURE.md" is an editorial
// judgement, so it is reported as a warning the author can dismiss.

/** What the check needs in order to judge a change. */
export interface DocSyncInput {
  /** Repository-relative paths this change touches. */
  readonly files: readonly string[]
}

/**
 * Read the paths a repository currently has changed, staged or not.
 * @param git - the runner for the repository.
 * @param signal - caller-owned cancellation.
 * @returns repository-relative paths, or a failure to report.
 */
export async function listChangedFiles(
  git: GitRunner,
  signal?: AbortSignal,
): Promise<{ ok: true; files: string[] } | { ok: false; failure: string; stderr: string }> {
  const result = await git.run(['status', '--porcelain=v1', '--untracked-files=all'], signal)
  if (!result.ok) return { ok: false, failure: result.failure, stderr: result.stderr }
  const files: string[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.length < 4) continue
    // `XY path`, or `XY original -> path` for a rename. The second path is the
    // one that exists now, which is what the rules are written against.
    const entry = line.slice(3).trim()
    const arrow = entry.indexOf(' -> ')
    const path = arrow === -1 ? entry : entry.slice(arrow + 4)
    files.push(unquote(path))
  }
  return { ok: true, files }
}

/**
 * Strip the quoting git adds around paths with unusual characters.
 * @param path - a path as printed by `git status`.
 * @returns the path without surrounding quotes and with its escapes resolved.
 */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path
  const inner = path.slice(1, -1)
  return inner
    .replace(/\\(["\\])/g, '$1')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
}

/**
 * Check whether the documents a repository pairs with its code were updated.
 * @param input - the paths this change touches.
 * @param config - resolved plugin configuration.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function checkDocSync(input: DocSyncInput, config: Config, t: Translate): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const changed = new Set(input.files)
  const docsDir = config.docs.docsDir.get()
  const changelog = config.docs.changelog.get()
  const readme = [...config.docs.readme.get()]
  const codePaths = [...config.codePaths.get()]
  // Excluded prefixes are removed from the "is this a code change" question
  // before it is asked, so a tree kept under `codePaths` can opt out by path.
  const excluded = [...config.docs.exclude.get()]

  const mirrors = [...config.docs.mirrors.get()].map((group) => [...group])
  for (const group of mirrors) {
    const touched = group.filter((path) => changed.has(path))
    if (touched.length === 0 || touched.length === group.length) continue
    const missing = group.filter((path) => !changed.has(path))
    errors.push(
      t('tool.check_doc_sync.error.mirror', {
        changed: touched.join(', '),
        missing: missing.join(', '),
      }),
    )
  }

  const code = input.files.filter(
    (path) =>
      !excluded.some((prefix) => path.startsWith(prefix)) &&
      codePaths.some((prefix) => path.startsWith(prefix)) &&
      !path.startsWith(docsDir),
  )
  const documents = [...changed].filter(
    (path) => path.startsWith(docsDir) || readme.includes(path) || path === changelog,
  )

  if (code.length > 0 && documents.length === 0) {
    warnings.push(
      t('tool.check_doc_sync.warn.no_document', {
        count: code.length,
        example: code[0]!,
        docsDir,
      }),
    )
  }
  if (code.length > 0 && !changed.has(changelog)) {
    warnings.push(t('tool.check_doc_sync.warn.changelog', { changelog }))
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Build the `check_doc_sync` tool.
 * @param options - the active translator, configuration, and a git runner bound
 *   to the caller's working directory.
 * @param options.t - translator for parameters, descriptions, and output.
 * @param options.config - resolved plugin configuration.
 * @param options.git - runner used when the caller does not pass explicit paths.
 * @returns the registry-ready tool definition.
 */
export function createCheckDocSyncTool(options: {
  t: () => Translate
  config: () => Config
  git: (cwd: string) => GitRunner
}) {
  return defineTool({
    name: 'check_doc_sync',
    description: options.t()('tool.check_doc_sync.description'),
    parameters: {
      files: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: options.t()('tool.check_doc_sync.param.files'),
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' as const, required: true as const },
          errors: {
            type: 'array' as const,
            required: true as const,
            items: { type: 'string' as const },
          },
          warnings: {
            type: 'array' as const,
            required: true as const,
            items: { type: 'string' as const },
          },
          error: { type: 'string' as const },
        },
      },
      render: (args, value) => {
        void args
        return renderCheck(
          {
            ok: value.ok,
            errors: value.errors,
            warnings: value.warnings,
            ...(value.error === undefined ? {} : { error: value.error }),
          },
          options.t(),
          'tool.check_doc_sync.ok',
        )
      },
    },
    execute: async (args, exec) => {
      const t = options.t()
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()

      let files = args.files
      if (files === undefined) {
        const listed = await listChangedFiles(options.git(cwd), exec.signal)
        if (!listed.ok) {
          return {
            ok: false,
            errors: [],
            warnings: [],
            error: t(`error.${listed.failure.replace(/-/g, '_')}`, {
              detail: listed.stderr.trim(),
            }),
          }
        }
        files = listed.files
      }
      return checkDocSync({ files }, options.config(), t)
    },
  })
}
