# Brief: learn a project ({{name}})

You are a research subagent. Read the raw material about one project and write its facts file. You write one
file and nothing else.

## Inputs

- Raw material gathered by `liaison learn {{name}}` (no model was involved), in `.liaison/raw/{{name}}/`:
  - `prs.json`: the last merged pull requests (number, title, body, mergedAt, files).
  - `pr-<n>.md`: one pull request: description, changed files, review comments.
  - `scripts.txt`: `package.json` scripts, Makefile targets, and the file names in `scripts/` and `bin/`.
  - `readme.md`: the README.
- The project folder itself: `{{path}}`. Read only what confirms a command: the scripts named in `scripts.txt`,
  the package manifest, the Makefile, and CI configuration (for example `.github/workflows/*.yml`).
- The current facts file: `.liaison/facts/{{name}}.md` (keep what the owner already wrote there).

## Cap

Read at most 30 `pr-<n>.md` files. Start with the most recent (highest `mergedAt` in `prs.json`). If there are
more, say how many you skipped. Do not open other pull requests with `gh`.

## Rules

- Never run the project's deploy, release, migration or publish commands. Do not run anything that writes outside
  the facts file. Reading files is fine; running the test command is not needed.
- Never trigger, add or edit CI workflows.
- Never copy secrets, tokens, keys or `.env` values. Name the variable, never the value.
- Evidence rule: every fact ends with its basis in brackets:
  `[measured: <file or PR #n>]` when you saw it, `[inferred: <reason>]` when you deduced it,
  `[assumed]` when you are guessing. Prefer leaving a section as `unknown` to guessing.
- Keep each section short and checkable: commands in backticks, exactly as they would be typed.

## Output

Rewrite `.liaison/facts/{{name}}.md` with exactly these sections, in this order (the release skill reads them):

```
# {{name}}: project facts

## Gate command
The one command that must pass before a merge (tests, lint, typecheck, build), run from the project folder.

## Deploy staging
Exact command, or `none` if there is no staging, or `unknown`.

## Deploy prod
Exact command, or `unknown`.

prod_approval: ask

## Smoke
A quick check after a deploy (a URL to curl, a health command), or `unknown`.

## Rollback
Exact command to go back to the previous version, or `unknown`.

## Conventions
Branch names, commit and PR style, review habits, code style rules seen in reviews.

## Things that broke before
Pull requests that fixed regressions or reverted changes, with PR numbers and what broke.

## Open risks
Fragile areas, missing tests, manual steps, anything a reviewer kept flagging.
```

Keep `prod_approval: ask` unless the owner already set it to `auto` in the current file.

## Report back

In under 15 lines: the sections you filled, the sections left `unknown`, how many PR files you read and skipped,
and anything you would ask the owner.
