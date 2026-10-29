// Conventional Commits enforcement for this repository.
//
// `@commitlint/config-conventional` already allows exactly the eleven types
// documented in CONTRIBUTING.md (build, chore, ci, docs, feat, fix, perf,
// refactor, revert, style, test), so the shared config is used as-is rather
// than restating the list in two places that can drift apart.

// Dependabot writes its own commit body: one line per release/commits URL,
// several hundred characters wide, and no human is at the keyboard to wrap it.
// `body-max-line-length` exists to keep hand-written messages readable, so the
// exemption is scoped by authorship, not by loosening the width for everyone.
const DEPENDABOT_SUBJECT = /^chore\(deps(?:-dev)?\): bump /
const DEPENDABOT_TRAILER = 'Signed-off-by: dependabot[bot]'

export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => DEPENDABOT_SUBJECT.test(message) && message.includes(DEPENDABOT_TRAILER)],
}
