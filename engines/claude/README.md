# Engine layer: Claude Code

Everything specific to one coding agent lives under `engines/<name>/`. Nothing outside `engines/` and `skills/`
mentions the agent by name (the root `CLAUDE.md` and `.claude/` are the files Claude Code itself looks for).
v1 ships this engine only.

Accepted deviation: `hooks/context-guard.py`, `lib/guard.sh`, `lib/discover.sh` and `bin/liaison` mention Claude Code
outside `engines/`, because they deal with hook and session mechanics (the hook protocol, the session id, where
Claude Code keeps its MCP configuration). Another engine would replace those call sites along with this folder.

## The contract

An engine must provide:

1. **Project instructions and hooks.** A way to install instructions for the session and the context-guard hook
   into the office folder.
2. **Launch.** A way to start a session in a folder with a prompt, used by the supervisor.
3. **Skills.** A place where the agent reads skills from, and an installer that puts the repo's `skills/*` there.
4. **Shell aliases.** The lines `./setup` appends to the shell rc (inside a `# liaison start` / `# liaison end` block).

## What this engine provides

| Contract item | Claude Code | File |
| --- | --- | --- |
| Instructions | root `CLAUDE.md`, read from the project folder; it branches on whether `.liaison/state.json` exists | `CLAUDE.md` |
| Hooks | committed project settings with the `hooks` key only: `PostToolUse` and `Stop` run the guard, `SessionStart` runs it for `compact` only | `.claude/settings.json` (same content as `engines/claude/settings.json`) |
| Permissions | allowlist merged into git-ignored local settings: `liaison`, `slack-say/ask/inbox/wait`, the `bin/liaison` and `bridge/bin/slack-*` fallbacks used before PATH is fixed, read-only `git` and `gh pr` | `.claude/settings.local.json`, written by `install.sh` |
| Skills | `<office>/.claude/skills/<name>/SKILL.md`; each skill is removed and copied again on every run, your own skills are left alone | `install.sh` (source: `skills/`) |
| Launch | `engine_launch_cmd <dir> <prompt-file> <effort>` prints `claude --effort <effort>`, plus `--dangerously-skip-permissions` only when `permission_mode` is `unattended`; `engine_resume_hint` prints `claude --continue` | `launch.sh` |
| Aliases | `claude3` and `claude5` (auto-compact window 300k / 500k), and `liaison-coordinator` in unattended mode | `aliases.sh` |

The supervisor sources `launch.sh`, runs `cd <dir>`, starts the printed command and types the contents of the
prompt file into the session. The command line never contains the prompt.

## Install

`./setup` runs the engine step for you. By hand:

    /bin/bash engines/claude/install.sh <office>

It is safe to run again. It copies skills (set `LIAISON_SKILLS_SRC` to read them from somewhere other than
`<repo>/skills`), merges the allowlist (an entry already present is not added twice, nothing you added is
removed), and leaves `.claude/settings.json` alone. If `settings.local.json` is not valid JSON it stops and
leaves the file as it is.

## The office is the project folder

The hook command is `python3 "$CLAUDE_PROJECT_DIR/hooks/context-guard.py"`. The guard finds the office from
`CLAUDE_PROJECT_DIR` (falling back to the session's working directory) and keeps its registrations in
`<office>/.liaison/guard`, or in `LIAISON_STATE_DIR` when that is set. So `LIAISON_OFFICE` must equal the folder
Claude Code is opened in, which by default is this checkout. Open a session anywhere else and the hooks do not
find `hooks/context-guard.py`.

## Permission mode

`permission_mode` in `.liaison/config.json` is `supervised` (default) or `unattended`. Unattended is not
written to any settings file; the flag is passed when the session is launched.
