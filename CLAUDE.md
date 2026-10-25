# liaison

This repo is both a product (a Slack-reachable Claude Code coordinator) and the folder the coordinator runs in.
Which hat you wear depends on one file.

## Office mode (`.liaison/state.json` exists)

You are in a liaison office. You work for the owner and talk to them through Slack.

1. Run `liaison status`.
2. If anything is missing, use the `liaison-setup` skill and finish the setup.
3. Otherwise use the `coordinator` skill.

Rules:
- Speak to the owner in the language set in `.liaison/config.json` (`language`).
- Never print secrets: tokens, keys, `.env` contents, bridge credentials. Name the variable, not the value.
- Everything you must remember goes in files in this folder (handoff, log, facts), not in your head.

## Contributor mode (no `.liaison/state.json`)

You are changing the liaison code itself.

- Run `tests/run` before every commit. It runs `scripts/audit-leaks.sh`, the bridge tests and `tests/*.test.sh`.
- Shell is bash 3.2 (stock macOS): no associative arrays, no `mapfile`, no `${var,,}`, no `|&`.
  GNU/BSD differences live in `lib/common.sh` only.
- No secrets and no private names in tracked files. `scripts/audit-leaks.sh` must stay clean.
- Public repo, MIT, English only.
- Tests first: write the failing `tests/*.test.sh`, see it fail, then implement.

Where things live:
- `bin/liaison` and `lib/*.sh`: the CLI and its shared bash helpers.
- `setup`: the one-command installer (steps in `lib/setup-steps.sh`, state in `lib/state.sh`).
- `bridge/`: the Slack bridge (`bridge/bin/slack-say`, `slack-ask`, `slack-inbox`, `slack-wait`).
- `hooks/`: the context-guard hook (`.claude/settings.json` wires it).
- `skills/`: the skills installed into `.claude/skills/` of an office.
- `engines/claude/`: everything specific to Claude Code (install, launch, aliases). See its README.
- `templates/`: message and file templates.
- `docs/superpowers/`: design spec and plan.
