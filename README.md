# liaison

Run Claude Code like a teammate: reachable on Slack, with handoffs that survive restarts and compaction.

liaison is one Claude Code session that works as your coordinator. You message it in Slack, it hands the reading and
the coding to subagents, writes down where things stand in plain files, and asks you with buttons when it needs a call.
Waiting for you costs nothing: a small daemon waits, not the model.

## Start

```
git clone https://github.com/ederwii/liaison.git && cd liaison
./setup
claude
```

`./setup` shows how to create the Slack app from `bridge/slack-manifest.yml`, asks for its two tokens (hidden input)
and your Slack member ID (shown as you type, it is not a secret), starts the bridge, creates `#liaison-office` and
offers the shell aliases `claude3` and `claude5`, which start `claude` with a 300k or 500k auto-compact window.
If it stops halfway, run it again:
finished steps are skipped. `liaison status` shows the checklist and `liaison verify` sends a test message through
the whole path.

## What you get

When setup ends, a greeting is waiting in `#liaison-office` in your Slack workspace: "what should I work on first?".
Open Claude Code in this folder and the session finishes whatever is left, then runs your work from Slack.

## Two modes

**Simple** (the default)
- One coordinator session in this folder, reachable on Slack.
- Subagents do the reading and the building; a separate reviewer checks before anything merges.
- A handoff file keeps the state, so a restart or a compaction loses nothing.

**Advanced** (`liaison advanced enable`)
- Everything in simple mode, plus departments: long-lived Claude Code sessions in tmux, each with its own folder,
  identity and Slack channel.
- A roster file lists them; a supervisor pass starts the ones that are down and never kills anything.
- See [advanced/README.md](advanced/README.md).

## Requirements

git, [Claude Code](https://claude.com/claude-code), python3, jq, curl, a Slack workspace where you can create an app,
macOS or Linux. `./setup` offers to install Bun if it is missing (with `--yes`, pass `--install-bun`). `gh` is
optional (needed to merge and to learn from past pull requests). `tmux` is needed for advanced mode only.

Contributors: `scripts/audit-leaks.sh` (run by `tests/run`) checks generic leak patterns and, when
`~/.liaison/audit-terms` exists, the maintainer's private deny-list.

macOS with bash: Terminal opens login shells, which read `~/.bash_profile`, not `~/.bashrc`. Source `~/.bashrc` from
`~/.bash_profile` (`[ -f ~/.bashrc ] && . ~/.bashrc`) or paste the alias block there, or the aliases will not appear.

## Where things live

- `.liaison/` in this folder: the office's state (setup progress, config, facts, the handoff). Git-ignored.
- `~/.liaison/`: your Slack tokens (`.env`, mode 600), the channel registry, and the bridge's inbox and outbox files.
- `~/.local/bin`: links to `liaison` and the `slack-*` commands, if you said yes.

## Uninstall

```
liaison daemon stop        # if setup installed an autostart service, remove it first (below)
rm -rf ~/.liaison          # tokens, registry, inbox and outbox files
```

- Autostart service: macOS `launchctl bootout gui/$(id -u)/liaison-bridge` then
  `rm ~/Library/LaunchAgents/liaison-bridge.plist`; Linux `systemctl --user disable --now liaison-bridge` then
  `rm ~/.config/systemd/user/liaison-bridge.service`.
- Shell rc: delete the block between `# liaison start` and `# liaison end`. Remove the links in `~/.local/bin`
  (`liaison`, `slack-*`) and this folder when you are done.

## More

- [docs/how-it-fits.md](docs/how-it-fits.md): the pieces and how they connect.
- [docs/faq.md](docs/faq.md): why Slack, why Bun, what it reads, how to stop it.
- [advanced/README.md](advanced/README.md): departments in tmux.
- [engines/claude/README.md](engines/claude/README.md): the Claude Code layer, and how another engine would plug in.

MIT licensed.
