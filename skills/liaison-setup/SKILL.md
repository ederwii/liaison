---
name: liaison-setup
description: Use in a liaison office when `liaison status` shows a step that is not ok - walk the owner through each missing step, run the onboarding questionnaire, discover tools, offer to learn each project, then hand over to the coordinator skill.
---

# Liaison setup

Finish the install with the owner, one step at a time, then hand over to the `coordinator` skill.
Speak to the owner in `language` from `.liaison/config.json` (English when it is not set yet).

## 1. Read the checklist

```
liaison status
```

One line per step, then a `next:` line. Exit 0 means every step is `ok` or `skipped`.

| Line | Meaning |
|---|---|
| `<step>: ok (detail)` | done |
| `<step>: missing` | never done: fix it (section 3) |
| `<step>: skipped (detail)` | the owner declined; counts as done |
| `path: not on PATH` | the links exist but this shell's PATH lacks `~/.local/bin` (checked live, not stored) |

If `liaison` is not found, the PATH step is not done yet: use `bin/liaison` and `bridge/bin/slack-*` from the office
folder until it is.

## 2. Where to talk

- Slack works once `tokens`, `daemon` and `office_channel` are `ok`: talk there with `slack-say` and `slack-ask`
  (see the `slack-bridge` skill), from the office folder.
- Before that, talk in the terminal. Never ask for tokens on Slack or in chat: they are typed only into `./setup`,
  whose input is hidden.

## 3. Fix each step that is not ok

Work top to bottom. After each fix, run `liaison status` again and say what changed (measured: its output).

| Step | Who fixes it | Exact command | What to tell the owner |
|---|---|---|---|
| `bun` | owner, in a terminal | `./setup` | "liaison needs Bun to run the Slack bridge. Run `./setup` in this folder; it offers to install Bun." |
| `language` | owner, in a terminal | `./setup --language <xx> --permission-mode <supervised or unattended>` | "Pick the language I reply in and whether I may run without permission prompts (unattended) or ask first (supervised)." |
| `tokens` | owner, in a terminal | `./setup` | "Run `./setup` in a terminal in this folder. It shows how to create the Slack app from the manifest and asks for two tokens and your member ID with hidden input. Do not paste tokens here." |
| `daemon` | you | `liaison daemon start` then `liaison daemon status` | "The Slack bridge is running" only after `liaison daemon status` prints `running (pid N)`. |
| `office_channel`, `greeting`, `engine` | you, only when `bun`, `language` and `tokens` are ok and `path` is ok or skipped | `./setup --yes --no-aliases --no-autostart` | "I created the office channel `#liaison-office`, sent the greeting there and installed my skills and hooks. Restart Claude Code here so they load." |
| `path` | owner, in a terminal | `./setup` and answer yes to linking | "This puts `liaison` and the `slack-*` commands on your PATH (in `~/.local/bin`). Then open a new terminal." |
| `projects` | you, with the owner's answer | `liaison register <path>` or `liaison new <name>` | Ask which project to work on (below). |
| `facts` | you | `liaison discover` | Nothing; say what tools you found if the owner asks. |

Notes:
- `./setup --yes --no-aliases --no-autostart` runs every remaining setup step with its default and never prompts:
  it creates the office channel with the default name `liaison-office`, sends the greeting, installs the skills and
  hooks, starts the daemon by hand if it is not running (no launchd/systemd service), and leaves the shell rc alone.
  With `path` still missing it would also link commands into `~/.local/bin` without asking, which is why `path`
  must be ok or skipped first. Tell the owner the channel can be renamed later with
  `slack-register --office <office-path> --channel <name>`.
- If setup prints `greeting: queued, not delivered yet`, the `greeting` step stays `missing`: do not say it was sent.
  Run `liaison verify`, read its first failing line, fix that, and run `./setup --yes --no-aliases --no-autostart` again
  (it checks the queued greeting instead of sending a second one).
- `skipped` means the owner declined. Offer once, say what it costs them to leave it, and accept a no.
- In `supervised` mode, any command not in `.claude/settings.local.json` will prompt at the terminal (here:
  `./setup`). Tell the owner before running one:
  "Next step needs you at the terminal to approve `./setup --yes --no-aliases --no-autostart`."
- A step that fails twice: show the owner the exact error line and stop; do not loop.

### Ask which project

```
slack-ask 'Which project should I work on? Reply with the full path of an existing git folder, or a short name (lowercase, hyphens) to start a new one.' --type text --timeout 1d --default skip
```

Arm `slack-wait` in the background and end the turn; the answer arrives in the inbox. Then:

```
liaison register <path>
liaison new <name>
```

`register` takes an existing folder (`--name n` and `--channel c` are optional); `new` creates
`projects/<name>` with `git init`. Both create `.liaison/facts/<name>.md` from `templates/project-facts.md`.
`skip` (or the timeout): run `liaison register --none` (records `projects: skipped`, so `liaison status` can exit 0),
tell the owner they can name one any time, and continue.

## 4. Onboarding questionnaire (optional)

Skip this section if `.liaison/facts/owner.md` exists. Otherwise follow `templates/owner-questionnaire.md`: an offer
first, then six questions, one at a time, each with `--timeout 1d` and a default so nothing hangs:

1. What you are building (`--type text`)
2. Stack (`--type text`)
3. How you ship (`--type text`)
4. How chatty reports should be (`--type select`)
5. Timezone and working hours (`--type text`)
6. Review strictness (`--type select`)

Track each question id and answer in the handoff as you go (so a restart resumes where it stopped) and write
`.liaison/facts/owner.md` once, after the last answer, in the template's shape. An answer applied by the timeout
(`via: timeout-default`) is recorded as `skip (no answer)`.

## 5. Discover the tools

Run it even when `facts` is already `ok` (it is cheap, no model involved) and read the result:

```
liaison discover
```

Then Read `.liaison/facts/tools.md`.

It lists CLIs, the GitHub login, MCP server names and the Claude Code version. If `gh` is missing or not logged in,
tell the owner: "Releases need the GitHub CLI: run `gh auth login` in a terminal."

## 6. Offer to learn each project

For each project in `.liaison/config.json` (`projects[]`) whose `.liaison/facts/<name>.md` still has empty sections:

```
slack-ask 'Should I learn <name> from its last 30 merged pull requests, scripts and README? One subagent reads them and fills its facts file for you to check.' --type yesno --timeout 1d --default no
```

`yes`: run the "learn" recipe in the `coordinator` skill (section 8). It starts with `liaison learn <name>`.

## 7. Hand over

Hand over when `liaison status` exits 0, or when every line that is not `ok`/`skipped` is one of:
- `projects: skipped` (after `liaison register --none`) because the owner chose to skip naming a project: write that
  in the handoff's Queue ("owner skipped naming a project; ask again when they bring work").
- `path: not on PATH`: tell the owner once, exactly, to add `export PATH="$HOME/.local/bin:$PATH"` to their shell
  rc and open a new terminal, then move on (use `bin/liaison` and `bridge/bin/slack-*` meanwhile).

Then:

1. Tell the owner setup is complete, in one message, and what you will do next.
2. Verify that send by its outbox line (`slack-bridge` skill).
3. Switch to the `coordinator` skill and run its start sequence.
