# commitcheck

Commit hygiene checker for a git repository's recent history. It reads
the most recent 50 commits and checks subject length, placeholder
subjects, DCO `Signed-off-by` trailers, malformed trailers, and whether
each commit follows the message convention the repo itself actually
uses. Every finding names the rule and the short sha of the commit it
came from.

## Install

```sh
npx @reneturcios/commitcheck check [path]
```

Or install it globally:

```sh
npm install -g @reneturcios/commitcheck
```

Requires Node 20 or newer and `git` on PATH.

## CLI

```sh
commitcheck check [path] [--json]   # check a repo (default path: .)
commitcheck mcp                     # run the MCP server on stdio
commitcheck --version               # print the version
```

Exit codes: `0` when the verdict is CLEAN, `1` when it is FINDINGS,
`2` for a usage error or an unreadable target, and `141` when the
reader closed the output pipe early (the shell-visible equivalent of
death by SIGPIPE).

Findings are printed in git log order, newest first, and the order is
deterministic for a given history.

## MCP

The MCP server exposes one tool:

- `check_commits` with argument `path`: runs the same check as the CLI
  and returns the full report as JSON.

## Rules

| Rule | Severity | What it means |
| --- | --- | --- |
| `SUBJECT-TOO-LONG` | medium | The subject line is over 72 characters. |
| `SUBJECT-VAGUE` | low | The subject is empty or a placeholder such as `wip`, `fix`, `update`, `changes`, or `.` |
| `NO-SIGNOFF` | medium | The commit has no `Signed-off-by` trailer, in a repo whose history follows the DCO convention (see below). |
| `CONVENTION-BREAK` | low | The subject breaks the dominant message style of the range (see below). |
| `MERGE-COMMIT` | info | A merge commit, reported for context. Merge commits are never a finding above info. |
| `TRAILER-MALFORMED` | low | A `Signed-off-by` line without an email shape, for example `Signed-off-by: Jane Doe` with no `<name@example.com>`. |

The verdict is CLEAN when the range has no medium findings, and
FINDINGS otherwise. Low and info findings are reported but do not
change the verdict.

## The adaptive rules, stated plainly

commitcheck does not impose a house style. Both convention checks are
learned from the range being checked:

- **DCO / sign-off.** A commit is flagged `NO-SIGNOFF` only when the
  repo demonstrably uses sign-off: at least half of the *other*
  commits in the range carry a well-formed `Signed-off-by` trailer.
  If the repo does not use sign-off, no commit is flagged for missing
  it. A malformed sign-off line does not count as a sign-off.
- **Message convention.** Two styles are tracked: conventional
  subjects (`type: summary` or `type(scope): summary`) and capitalized
  imperative subjects (`Add the thing`). When one style is used by at
  least 70 percent of the non-merge commits in the range, it is the
  dominant style, and a commit that breaks it is flagged
  `CONVENTION-BREAK`. When no style reaches 70 percent, nothing is
  flagged for style.

## Limits

- Only the last 50 commits are checked.
- Style detection is statistical. A short or mixed history may have no
  dominant style, in which case no convention findings are produced.
- Sign-off presence is checked, not signature validity. commitcheck
  verifies that a `Signed-off-by` trailer with an email shape exists;
  it does not verify that the signer is the author or that any
  signature is genuine.
- Merge commits are detected from the `Merge ...` subject line, which
  is the default git shape; a hand-written subject that starts with
  `Merge` will be reported as one.
