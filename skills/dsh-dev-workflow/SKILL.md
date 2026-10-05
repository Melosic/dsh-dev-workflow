---
name: dsh-dev-workflow
description: >
  Development-workflow gatekeeper. Use when starting a feature, preparing a
  commit, opening a pull request, or preparing a release. Covers branch naming,
  commit message format, documentation sync, CHANGELOG upkeep, and release rules.
---

# dsh-dev-workflow

This file is the single source of truth for how this project is developed. It is
read on demand — nothing below is resident context.

## Core Principles

- **Automation over memory.** A rule that tooling can check should be checked by
  tooling, not recalled by discipline. Anything mechanically verifiable belongs
  in CI or a hook.
- **Atomic changes are recommended, not enforced.** Keep one commit per
  independent logical change, but atomicity needs semantic judgement, so it is
  never a hard gate.
- **Documentation is code.** The docs that describe a change ship in the same
  PR as the change.
- **Quality gates come first.** Typecheck, lint, format, and tests run before
  review, so a reviewer reads intent instead of noise.
- **Secure by default, explicit confirmation.** Destructive operations default
  to asking, never to allowing.
- **Trigger on the action, not on a mode switch.** The workflow appears when the
  user is about to commit, branch, or release. Users forget to switch modes;
  actions do not lie.
- **Stay quiet until then.** No nagging and no full-spec dump on every turn. The
  resident cost is one summary line; the full text is read only on demand.

## Branch Model (GitHub Flow)

- `main` is always releasable and is protected: no direct pushes, everything
  lands through a pull request, and required checks must pass.
- Work happens on short-lived branches created from an up-to-date `main`:

  | Prefix      | Use                       |
  | ----------- | ------------------------- |
  | `feature/*` | new capability            |
  | `fix/*`     | bug fix                   |
  | `docs/*`    | documentation only        |
  | `hotfix/*`  | urgent fix against `main` |

- Use kebab-case and a topic that reads on its own: `feature/skill-md`,
  `fix/guard-force-push` — not `feature/stuff`.
- Keep a branch on one topic. Merge from `main` or rebase onto it to stay
  current, and resolve conflicts on the branch, never on `main`.
- Merging uses **squash merge**, so `main` keeps one commit per pull request and
  a linear history.
- Delete the branch as soon as the pull request is merged.

## Commit Messages (Conventional Commits)

```text
<type>(<scope>): <subject>

<body>

<footer>
```

- `scope` is optional but encouraged when a change is clearly local.
- **Subject**: imperative mood ("add", not "added"), no trailing period, and at
  most 50 characters.
- **Body**: wrap at 72 characters and explain *why*. Do not restate what the
  diff already shows.
- **Footer**: reference issues (`Closes #12`) and record breaking changes.

  | Type       | Meaning                                             |
  | ---------- | --------------------------------------------------- |
  | `feat`     | a new user-visible capability                        |
  | `fix`      | a bug fix                                            |
  | `docs`     | documentation only                                   |
  | `style`    | formatting, no behaviour change                      |
  | `refactor` | internal change that is neither a fix nor a feature  |
  | `perf`     | a change that improves performance                   |
  | `test`     | adding or fixing tests                               |
  | `build`    | build system or dependencies                         |
  | `ci`       | CI configuration and scripts                         |
  | `chore`    | maintenance that fits nowhere else                   |
  | `revert`   | reverting an earlier commit                          |

- Breaking change: append `!` after the type or scope (`feat(api)!: ...`) **and**
  explain it in a `BREAKING CHANGE:` footer.
- The 50/72 rule is not cosmetic. Many tools truncate a subject, and a wrapped
  body stays readable in a terminal and in a diff.

## Atomic Commits (Recommended Practice)

- An atomic commit solves exactly one independent logical problem and can be
  described by a single line of intent.
- This is **recommended, not required**. Atomicity rests on semantic judgement —
  whether two edits belong together depends on intent, not on file paths — so it
  cannot be checked mechanically and is never a merge blocker.
- When preparing a commit, split it if the staged changes answer more than one
  question, or if reverting the change would have to be done in pieces. Keep it
  whole otherwise.
- **The user has the final say.** If they ask for a single commit, produce a
  single commit and state the tradeoff once.
- The pre-commit trigger does not check atomicity. It checks only what is
  mechanically verifiable: commit message format, CHANGELOG, and documentation
  sync.

## Pull Requests and Quality Gates

Before committing:

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` pass
      locally.
- [ ] The staged changes answer one question (see *Atomic Commits*).
- [ ] The commit message follows Conventional Commits.
- [ ] Documentation touched by the change is updated in the same commit or PR.
- [ ] `CHANGELOG.md` carries an `[Unreleased]` entry for the change.

Pull request description template:

```markdown
## What

## Why

## How to verify
```

A pull request is mergeable only when CI is green, the branch is up to date with
`main`, and every review conversation is resolved. Never merge by bypassing a
failing check: fix the cause, or report the blocker.

## Documentation Sync

| Change                                        | Update in the same PR                           |
| --------------------------------------------- | ----------------------------------------------- |
| User-visible behaviour                        | `README.md` **and** `README.zh.md`              |
| An entry point, data flow, or module boundary | `docs/ARCHITECTURE.md`                          |
| A config option, its default, or its values   | `docs/CONFIGURATION.md`                         |
| A tool: name, parameters, or returned text    | `docs/TOOLS.md`                                 |
| A trigger, or when one fires                  | `docs/TRIGGERS.md`                              |
| User-visible strings                          | `locale/en.json` **and** `locale/zh.json`       |
| Anything in this specification                | `SKILL.md` **and** `SKILL.zh.md`, same sections  |
| Any change at all                             | a `CHANGELOG.md` `[Unreleased]` entry           |

- Paired files move together or not at all. A half-synced pair is worse than a
  stale one, because it looks maintained.
- CI enforces what is mechanical: locale keys line up, and the two skill files
  expose the same sections in the same order. Whether a translation reads well
  stays a human review item.

## Releases (SemVer + Keep a Changelog)

- Versions follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.
  - `MAJOR` — incompatible changes.
  - `MINOR` — backward-compatible additions.
  - `PATCH` — backward-compatible fixes.
- **While the project is 0.x it makes no compatibility promise.** SemVer permits
  a 0.x `MINOR` bump to carry breaking changes; this project says so out loud and
  marks each one `BREAKING` in the changelog.
- `CHANGELOG.md` follows
  [Keep a Changelog 1.1.0](https://keepachangelog.com/1.1.0/): an `[Unreleased]`
  section always sits at the top, above the six categories `Added`, `Changed`,
  `Deprecated`, `Removed`, `Fixed`, and `Security`.
- Release flow:
  1. Confirm `main` is green and every intended change is merged.
  2. Move the `[Unreleased]` entries under a new `[<version>] - <YYYY-MM-DD>`
     heading, and leave `[Unreleased]` in place, empty.
  3. Bump `version` in `package.json` to match the new heading.
  4. Commit as `chore(release): <version>`, then tag `v<version>` and push it.
  5. Publish from the tagged commit with `npm publish`.
- Do not edit a released section. Corrections become new entries.

## Safe Operations

Destructive git commands. These rewrite or discard history and must never run
unprompted:

| Command             | Risk                                             |
| ------------------- | ------------------------------------------------ |
| `git push --force`  | overwrites remote history; can discard commits   |
| `git reset --hard`  | discards uncommitted work permanently            |
| `git clean -f`      | deletes untracked files permanently              |
| `git branch -D`     | deletes a branch whose commits may exist nowhere |
| `git rebase`        | rewrites history                                 |
| `git commit --amend`| rewrites a commit that may already be published  |
| `git checkout -- .` | discards every unstaged change                   |
| `--no-verify`       | skips the hooks that protect the repository      |
| `git push --delete` | removes a remote branch others may base work on  |

- Never hard-code a credential, and never write one into a log, a fixture, or a
  document. Secrets come from the environment or an untracked local file.
- Never read a sensitive file to "check" it: `.env`, `*.pem`, `*.key`,
  `id_rsa*`, `credentials`, `*.p12`, an `.npmrc` holding an auth token, and
  anything under `secrets/`.
- A force push must use `--force-with-lease`, which refuses to overwrite commits
  you have not fetched. A bare `--force` is never the answer.
- Do not bypass git hooks as a habit. `--no-verify` is an escape hatch for an
  emergency, not a workflow.
- An AI assistant must not run a destructive operation without explicit
  confirmation from the user for that specific action, and must name what will
  be lost.
- When a destructive command is requested, prefer the reversible form and say
  why.

## Automatic Triggers

- **Before a commit** — check the commit message against Conventional Commits,
  whether `CHANGELOG.md` needs an `[Unreleased]` entry, and whether the changed
  files took their documentation with them.
- **Before a branch, pull request, or release** — check the branch name, the
  pre-commit checklist, and the release steps.
- **Otherwise stay quiet.** Do not volunteer the specification, do not read its
  full text, and do not interrupt unrelated work. The resident cost stays at one
  summary line.
- If the user ignores a hint, let the action proceed. Do not repeat it: **the
  same hint about the same problem in the same session is raised once.** A
  repeated warning is noise, and noise trains people to click through warnings.
- Every hint must be actionable: name the problem, show the expected form, and
  offer the concrete fix. "Invalid commit message" is not a hint; "the subject is
  63 characters — Conventional Commits suggests 50 or fewer" is.
