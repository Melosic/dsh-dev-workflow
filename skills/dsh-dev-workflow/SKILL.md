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
  to asking, never to allowing. So do the actions other people can see — a commit
  the user has not approved, a push, a tag, a pull request, a publish.
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

- Branch names are all lowercase and kebab-case (the same style as the type and
  scope in a commit). A name that reads on its own is required: `feature/skill-md`
  and `fix/guard-force-push`, not `feature/stuff` or `feature/NewStuff`.
- Keep a branch on one topic.
- Stay current with `git merge main`, not `git rebase main`. Under squash merge a
  rebase rewrites the branch's own history, so a reviewer can no longer see what
  changed since the last review.
- Resolve conflicts on the branch, never on `main`.
- After resolving a merge conflict, re-run `pnpm typecheck`, `pnpm lint`, and
  `pnpm test` before committing. A conflict resolution can change what the code
  means, so the earlier green run no longer covers it — committing without
  re-verifying treats the merge as risk-free text editing.
- Merging uses **squash merge**, so `main` keeps one commit per pull request and
  a linear history.
- The squash commit that lands on `main` takes its message from the **pull
  request title**, so the PR title must itself follow Conventional Commits.
- The commits on the branch are squashed away and never appear in `main`'s
  history. This is why the PR title matters more than any single commit on the
  branch.
- Delete the branch as soon as the pull request is merged.

### Branch Protection

`main` is protected in the repository settings, not by convention. The rules:

- Direct pushes are forbidden.
- Force pushes are forbidden.
- Deletion is forbidden.
- A pull request is required, with at least one review.
- All required CI checks must pass.
- The branch must be up to date with `main` before it can merge.
- Every review conversation must be resolved.

These are configured on the GitHub repository itself, so they hold for everyone,
including an administrator.

### Hotfix Flow

- Cut a `hotfix/*` branch from `main`, never from a feature branch.
- When the fix is done, merge it straight back into `main`. There is no
  `develop` or `release` branch in this model to route it through.
- Write the hotfix's `CHANGELOG.md` entry into `[Unreleased]`; it ships with the
  next release like any other change.
- If the problem is severe enough to need a release right away, follow
  *Withdrawing a Published Release* instead of inventing a second flow.

## Commit Messages (Conventional Commits)

```text
<type>(<scope>): <subject>

<body>

<footer>
```

- `scope` is optional but encouraged when a change is clearly local.
- **Subject**: imperative mood ("add", not "added"), no trailing period, and at
  most 50 characters. Write the subject in English, so it matches the `type` and
  `scope`, which are English by definition.
- **Body**: wrap at 72 characters and explain *why*. Do not restate what the
  diff already shows. A body or footer may be English or Chinese, but one
  project should pick one and stay with it.
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
- The footer is written exactly `BREAKING CHANGE: <explanation>` — all uppercase,
  a single space after the colon. The hyphenated `BREAKING-CHANGE` is a different
  token and is not recognised.
- The 50/72 rule is not cosmetic. Many tools truncate a subject, and a wrapped
  body stays readable in a terminal and in a diff.

### Issue References

- `Closes #12` — once this commit lands, issue #12 can be closed.
- `Refs #12` — this commit relates to issue #12 but does not close it.
- Several issues: `Closes #12, #15`.
- Reference the number only. A full URL is not used, because the repository is
  already known and the URL is longer than the fact it carries.

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

Before committing, **show the user what will be committed and wait for their
answer.** A commit is the first thing that becomes hard to take back: state the
branch, the staged files, and the message, then let them agree, change, or drop
it. It is their repository. The checklist below is what to verify before you ask,
not permission to skip the asking.

- [ ] The user has seen the exact changes and message, and agreed to them.
- [ ] Your project's own checks pass locally: typecheck, lint, format check, and
      tests, run with whatever commands that project defines.
- [ ] The staged changes answer one question (see *Atomic Commits*).
- [ ] The commit message follows Conventional Commits.
- [ ] Documentation touched by the change is updated in the same commit or PR.
- [ ] `CHANGELOG.md` carries an `[Unreleased]` entry for the change.

Pull request description template. The three section names must be kept verbatim
(in English — the gate matches them literally); the text under them may be in any
language:

```markdown
## What

Add a `--json` flag to the status command.

## Why

Scripts cannot parse the current prose output. Closes #7.

## How to verify

Run `/dev-workflow status --json` and check that the output parses.
```

A pull request is mergeable only when CI is green, the branch is up to date with
`main`, and every review conversation is resolved. Never merge by bypassing a
failing check: fix the cause, or report the blocker.

**Pushing, tagging, opening the pull request, and publishing each need their own
answer from the user first.** These leave this machine under their name; they are
not steps an assistant completes on its own initiative. Show the branch, the
remote, the tag or the version, and the exact command, then wait. One approval
covers that one action — consent to commit is not consent to push, and consent to
push is not consent to publish. When the user has not answered, the state is "not
yet done", not "done".

### Local Verification vs CI

- The local checklist above is a recommendation, not a hard gate.
- CI is the hard gate, and it cannot be bypassed. When it fails, fix the cause —
  never weaken the check, edit the CI configuration to route around it, or skip
  it with `--no-verify`.
- If the CI setup itself is wrong, open an issue for it rather than patching it
  inside an unrelated pull request.

### Pull Request Size

- Aim for roughly 200–400 changed lines.
- Past 500 lines, split the pull request, or walk a reviewer through it before
  they start reading.
- The reason is practical: a small pull request is reviewed quickly, conflicts
  with less, and is easy to revert if it turns out to be wrong. A large one
  tends to be approved on trust, which is the opposite of review.

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
- `docs/` always describes the current state of `main`. It is not versioned
  documentation: to read how an older version behaved, check out its git tag.

### When Documentation Sync Does Not Apply

These changes need no `README.md` and no `docs/` update:

- A purely internal refactor that leaves externally visible behaviour unchanged.
- A test-only change.
- A dependency upgrade that does not change user-visible behaviour.
- Code style or formatting.
- CI configuration.

The exemption covers prose only. If any of these does change what a user sees,
it still needs a `CHANGELOG.md` entry — the two obligations are separate, and
this list waives just one of them.

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
  6. Verify the publish landed: `npm view <package> versions` shows the new
     version, or `npx <package>@latest --version` installs and reports it. If
     the verification fails, check the dist-tag and the registry status before
     assuming the publish succeeded.
- Do not edit a released section. Corrections become new entries.

### Pre-release Versions

- A pre-release version follows SemVer:
  `MAJOR.MINOR.PATCH-<pre-release>`.
- The common identifiers are `-rc.1`, `-beta.1`, and `-alpha.1`, in descending
  order of readiness.
- A pre-release is not published to the `latest` tag. Publish it with
  `npm publish --tag next`, so nobody installs a release candidate by accident.
- Examples: `0.2.0-rc.1`, `1.0.0-beta.3`.

### Deprecation and Removal

- To deprecate something, add an entry under `Deprecated` in `[Unreleased]`
  naming the replacement and when the removal is planned.
- Keep a deprecated feature for at least one `MINOR` release before removing it.
  A security problem is the one reason to skip that wait.
- Removing it is a `Removed` entry, and under 0.x it is marked `BREAKING`.

### Rollback

- To roll back a published change, revert it with a `revert` commit and add an
  entry under the matching `[Unreleased]` category saying what was rolled back
  and why.
- Do not delete the original changelog entry. The changelog is a record of what
  happened, and a version that was published did happen.
- Whether a rollback needs its own release depends on how far the original
  change had spread; a rollback of something users already depend on does.

### Withdrawing a Published Release

- A version published less than 72 hours ago can be removed with
  `npm unpublish`.
- Past 72 hours, `npm unpublish` is no longer available. Deprecate the version
  with `npm deprecate` instead, then publish a fixed version.
- A deprecation message must state the problem, which versions are affected, and
  what to use instead. It is read by someone who already has the broken version
  installed, so it is the only place they will look.
- Never cover a bad release by deleting the version. Publish a new one.

## CHANGELOG Maintenance

The changelog answers one question for someone who is deciding whether to
upgrade: *what changed for me?* It is not a summary of the commit log.

### What to Write

- Any user-visible behaviour change: a new capability, a fix, a changed
  configuration option, or a changed API.
- A breaking change. Always, with a `BREAKING` marker and migration notes.
- A security fix — but do not disclose the vulnerability in the entry until the
  fix has been released.
- A deprecation: what is deprecated, what replaces it, and when it is planned to
  go away.

### What Not to Write

- Internal refactors, code style, test changes, and dependency upgrades.
- A restatement of the commit messages. The changelog is not a commit log.
- Implementation detail, such as which function was renamed.
- Anything that has not been released yet.
- Sensitive information of any kind.

### How to Write

- Use the imperative, and address the reader.
- One entry per change.
- Say what it means for the user, not what the code does.
- For a breaking change, give the migration path.

### Examples

| Bad entry                              | Why it falls short                                | Better entry                                                         |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `Fixed — fixed a bug`                  | A reader cannot tell whether it affects them.     | `Fixed — a failed push left the branch dirty; the error now rolls back` |
| `Added — refactored the parser`        | A refactor is not an addition, nor user-visible.  | `Changed — the parser accepts a single leading "+" before a number`  |
| `Changed — updated dependencies`       | A routine upgrade is not a change to the user.    | *(no entry)*                                                          |

### When to Write

- At the moment the change happens, into the matching `[Unreleased]` category.
- Not at release time. By then the detail is lost and the entries become vague.
- `docs`, `test`, `chore`, `ci`, and `build` commits usually need no entry.
- `feat`, `fix`, and `perf` need one. `refactor` needs one only when it changes
  something a user can observe. `revert` needs one.

### Dependency Upgrades

- A dependency upgrade does not get a changelog entry by itself.
- The exception is an upgrade that changes user-visible behaviour — for example,
  a parser that now rejects input it used to accept. That is written under the
  category it actually belongs to, not under `Changed — dependencies`.

### Breaking Changes

- Write the entry under the matching `[Unreleased]` category and prefix it with
  `**BREAKING:**`.
- Include the migration path: what to do instead, and what happens if you do
  nothing.
- This matters most in the 0.x stage, where a `MINOR` bump can carry the change.

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
- **The same goes for every action other people can see.** A push, a tag, a pull
  request, and a publish leave this machine under the user's name, and saying
  "done" before they agreed is the mistake these four have in common. Show what
  will leave, wait for the answer, and only then run it. A forced push is both:
  show the remote commit that will be overwritten as well.
- When a destructive command is requested, prefer the reversible form and say
  why.
- Scan the staged diff for credential patterns before committing. If one turns
  up, rotate the secret — deleting the commit is not enough. A secret that
  reached the remote is already exposed.

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
