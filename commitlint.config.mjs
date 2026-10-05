// Conventional Commits enforcement for this repository.
//
// `@commitlint/config-conventional` already allows exactly the eleven types
// documented in CONTRIBUTING.md (build, chore, ci, docs, feat, fix, perf,
// refactor, revert, style, test), so the shared config is used as-is rather
// than restating the list in two places that can drift apart.
export default {
  extends: ['@commitlint/config-conventional'],
}
