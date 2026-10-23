<!--
All seven headings below are read by the pre-pull-request check: a missing or
empty one is reported before `gh pr create` runs. Keep the names and their `##`
level exactly as they are — the text underneath may be in any language.

"None", "not applicable", or a single sentence is a complete answer for any of
them. What is not accepted is deleting the heading or leaving it blank: those
are the two states where the reviewer cannot tell "nothing to say" from "not
considered".
-->

## What

<!-- What changes, in one or two sentences. Name the behaviour, not the files. -->

## Why

<!--
Why this is needed, and what it fixes. Reference the issue if there is one:
`Closes #12` or `Refs #12`. If the change is not obvious, say what you
considered and rejected.
-->

## How to verify

<!--
The command or steps a reviewer runs to see it work, and what they should
observe. `pnpm test` passing is not verification of a behaviour change.
-->

## Type of change

<!-- Delete the lines that do not apply. -->

- Bug fix (behaviour that was wrong now is not)
- Feature (behaviour that did not exist now does)
- Breaking change (an existing caller must act)
- Documentation, tests, or CI only

## Non-goals

<!--
What this pull request deliberately does not do, and where that work goes
instead. This is the section that stops a reviewer from asking for a change you
already decided against.
-->

## Risk and rollback

<!--
What can go wrong, who notices, and how to undo it. If the answer is "nothing"
and "revert the commit", say so — that is a useful answer, not a skipped
question.
-->

## Checklist

<!-- Ticked by the author before asking for review. -->

- [ ] The change is one concern; anything unrelated is a separate pull request.
- [ ] Tests cover the behaviour, and they fail without the change.
- [ ] Documentation that describes this behaviour is updated in the same pull
      request.
- [ ] The `[Unreleased]` changelog entry is written.
- [ ] I have read the diff myself, not only the test output.
