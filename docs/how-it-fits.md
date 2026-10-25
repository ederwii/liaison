# How the pieces fit

liaison is small on purpose. Each piece has one job and one contract with the next, so you can read all of it in an
afternoon.

```
you (Slack) <-> bridge daemon <-> files in ~/.liaison <-> slack-* verbs <-> the coordinator session (Claude Code)
                                                                                  |  reads/writes
                                                                         .liaison/ (handoff, facts, state)
```

## Bridge (`bridge/`)

A daemon that holds the Slack connection (Socket Mode, so no public URL) and nothing else. It exchanges lines with the
session through files, never through a socket the session has to keep open.

- **Outbox** (one folder per project slug, `office` for the office channel): `~/.liaison/<slug>/outbox.jsonl`. `slack-say` and `slack-ask` append one line and exit. The daemon
  reads new lines and posts them. It keeps its place in `~/.liaison/state.json`; a failed delivery comes back as a
  `kind: error` line in the inbox.
- **Inbox**: `~/.liaison/<slug>/inbox.jsonl`. Your messages, your button clicks and system notices arrive here.
  `slack-inbox` reads it, `slack-wait` sleeps until something new arrives and then exits (that exit wakes the
  session), `slack-ack` reacts with a check mark to a message the session has read.
- **Registry**: `~/.liaison/projects.yml` maps folders to channels. The folder you run a verb in decides where it
  talks: a registered project's folder goes to that project's channel, everything else to the office channel.
  `slack-register` is the only thing that writes it (setup and `liaison register` call it).
- **Who may talk**: only the Slack member IDs in `~/.liaison/.env`. Everyone else in the channel is ignored.
- **Tokens** live in `~/.liaison/.env` (mode 600). Only the daemon reads them; the verbs never do.

## CLI and state (`bin/liaison`, `lib/`, `setup`)

`liaison` is a thin dispatcher over bash files in `lib/`. `./setup` and `liaison status` share one checklist,
`.liaison/state.json`: one line per step (`bun`, `tokens`, `daemon`, `office_channel`, `greeting`, `engine`, `path`,
`language`, `projects`, `facts`), each `ok`, `missing` or `skipped`. Choices go to `.liaison/config.json` and
per-project knowledge to `.liaison/facts/<project>.md`. `liaison verify` walks the whole path (daemon, office
registered, a test message queued, the daemon's delivery) and says which step broke.

## Hook (`hooks/context-guard.py`)

A Claude Code hook that reports how full the context window is and, for the session that ran
`liaison guard register` (the coordinator), asks for a fresh handoff as the window fills and refuses to let a turn end
with no `slack-wait` armed. Any other session in the folder only gets the context line. It never prints to the
session when it has nothing to say. The cost: the hook starts `python3` on every tool call and reads only the last
~3 MB of the transcript, never the whole file.

## Engine layer (`engines/claude/`)

Everything specific to Claude Code: the project settings, the allowlist, where skills are copied, how a session is
launched and the shell aliases. Nothing outside `engines/` and `skills/` has to change to support another agent;
the four things an engine must provide are listed in [engines/claude/README.md](../engines/claude/README.md).

## Skills (`skills/`)

Plain Markdown, copied into the office by setup.

- `liaison-setup`: finishes whatever `liaison status` shows as missing, with you, in your language.
- `coordinator`: the loop. Wake, handle, delegate to a subagent with a written brief, record, re-arm the wait.
- `slack-bridge`: how to use the verbs and how to check that a message really went out.
- `release`: gate, independent review, merge, deploy, smoke, rollback, using the commands in the project's facts file.

## Templates (`templates/`)

The first greeting, the handoff and its log, the project facts file, the onboarding questions, the brief for learning
a project, and the department identity files for advanced mode. Setup copies them; you can edit the copies.

## Leak audit (`scripts/audit-leaks.sh`)

`tests/run` starts with this script. It checks generic leak patterns (absolute home paths, email addresses, Slack member
ids) and, when `~/.liaison/audit-terms` exists, the maintainer's private deny-list, which is kept outside the repo.

## Advanced (`advanced/`)

A roster of departments and a supervisor script. Each department is a Claude Code session in tmux with its own folder,
`AGENT.md` and Slack channel. See [advanced/README.md](../advanced/README.md).

## A day in the office

1. You write in `#liaison-office`: "the export button times out on large files".
2. The daemon appends that to the office inbox. `slack-wait`, which the coordinator armed in the background, exits;
   the session wakes at no cost while it slept.
3. The coordinator replies "On it", writes a brief and starts a builder subagent in a branch of the project. It
   records the task in the handoff's STATE NOW and arms the wait again.
4. The builder finishes. A separate reviewer subagent checks the change. Only on the reviewer's OK does the
   coordinator merge.
5. Before the deploy it asks you with buttons: `slack-ask 'Deploy to production?' --type yesno --timeout 60m --default no`.
   Then it ends its turn. You tap yes an hour later; the answer lands in the inbox and wakes the session.
6. It deploys, runs the smoke command, and posts the result and the rollback command in the channel.
7. The machine restarts overnight. In the morning the session starts, reads the handoff, finds the wait unarmed,
   arms it and carries on. Nothing was held in memory.
