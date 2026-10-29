<!--
Seven of the headings below are read by the pre-pull-request check: a missing or
empty one is reported before `gh pr create` runs. Keep their names and `##` level
exactly as they are — the text underneath may be in any language.

"None", "not applicable", or a single sentence is a complete answer for any of
them. What is not accepted is deleting the heading or leaving it blank: those
are the two states where the reviewer cannot tell "nothing to say" from "not
considered".

`Where to look first` is the exception: it is not checked, and it is the one
heading you may delete outright when the diff is small enough to read in one
sitting.

Every `- [ ]` line under a heading the check reads is counted, so a ticked box is
the only way to answer it. If a checklist line genuinely does not apply, delete
that line and say why under Non-goals.
-->

## What

<!-- What changes, in one or two sentences. Name the behaviour, not the files. -->

## Why

<!--
Why this is needed, and what it fixes. If the change is not obvious, say what you
considered and rejected.

If there is an issue, give its number on its own line below this comment —
`Closes #123` makes GitHub close it when this lands, `Refs #123` keeps it open.
That line has to be real text, not part of a comment, or GitHub will not see it.
A bare `Closes #` with no number is not filled in; leave the line out if there is
no issue.
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

## Where to look first

<!--
Optional, and not required by the check: name the file or the decision a reviewer
should read before the rest. Useful on a large diff, safe to delete on a small
one.
-->

## Checklist

<!-- Ticked by the author before asking for review. -->

- [ ] The change is one concern; anything unrelated is a separate pull request.
- [ ] Tests cover the behaviour, and they fail without the change. If this is
      documentation, configuration, or a pure refactor, delete this line and say
      so under Non-goals.
- [ ] Documentation that describes this behaviour is updated in the same pull
      request.
- [ ] If this diff is over 500 lines, the description says why it cannot be
      smaller — which parts there are, and where to start reading. Under 500,
      delete this line.
- [ ] The `[Unreleased]` changelog entry is written.
- [ ] I have read the diff myself, not only the test output.
- [ ] No secret, token, or credential is added — not in code, not in a test
      fixture, not in this description.
