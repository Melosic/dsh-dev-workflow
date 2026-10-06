# dsh-dev-workflow

**English | [简体中文](README.zh.md)**

A development workflow for coding agents, packaged as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin: a written spec the
agent reads on demand, tools and triggers that enforce the parts a machine can check, and guards for
the actions that cannot be undone. It is a plugin, not a mode — it works on top of the modes you
already use.

## Why

Every project has a development workflow: how branches are named, how commits are written, when
documentation moves with the code, what has to be true before a release. Written down, those
conventions sit in a guide that nobody reads at the moment it applies — least of all an agent.
Unwritten, they get restated every session, and they drift.

This plugin turns that spec into something the agent carries and the tooling enforces. The full
workflow — branch model, commit format, atomic commits, PR quality gates, documentation sync,
release and CHANGELOG rules — ships as a skill read on demand, so it is there exactly when it
applies without costing every turn. What can be checked mechanically is checked for you; what
cannot be undone is gated first. It speaks at those moments, not between them.

## Features

- **Conventions as a skill, not a lecture.** The full spec is read on demand; what stays resident is a few hundred tokens.
- **Two check tools.** `check_commit_message` for Conventional Commits, `check_doc_sync` for docs that moved with the code.
- **Three triggers, quiet until they matter:** before a commit, before `gh pr create`, before `git tag` or a publish.
- **Four guards, one shape.** Irrecoverable shell commands, destructive git operations, sensitive reads, credentials in arguments.
- **One switch, and it is an install switch.** `/dev-workflow status` reports mode, locale, last check and guard activity; `off` unregisters everything.
- **A settings panel** in DeepSeek Harness Settings for every switch and enum, applied without a restart.

## Requirements

| Component | Version |
| --- | --- |
| DeepSeek Harness runtime | `>=0.2.0-rc.2` |
| Node.js | `>=20` |
| pnpm | `10.x` |

**An unsupported DeepSeek Harness version does not fail the install — it disables the plugin**,
leaving a plugin that is installed but never appears. Check `dsh --version` against the range above
before you file a bug; [docs/PUBLISHING.md](docs/PUBLISHING.md) explains how it is chosen and the
per-profile escape hatch.

## Quick Start

```bash
# Clone and install
git clone https://github.com/Melosic/dsh-dev-workflow.git
cd dsh-dev-workflow
pnpm install

# Build and verify
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Then install the plugin into a DeepSeek Harness profile:

```bash
dsh plugin --profile <profile> add @melosic/dsh-dev-workflow
```

To install from a local checkout instead, point the plugin manager at this package directory. To
confirm the plugin is live, run `/dev-workflow status` in DeepSeek Harness: it prints the mode, the
locale, the last check, the guard counters and the audit-log status. A guarded action — `git clean -f`
in a scratch repository, say — does not run unasked; it prompts for approval, or is denied outright
when approvals are turned off.

## Documentation

- [docs/README.md](docs/README.md) — the index of all documentation: start here and pick a reading path.
- [CHANGELOG.md](CHANGELOG.md) — release history, Keep a Changelog format.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to set up, branch, commit, and submit changes.

## Contributing

Contributions are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © 2026 Melosic
