# FAQ

**Why Slack?**
It is where most teams already are, it has buttons and threads, and Socket Mode lets a laptop receive messages
without a public URL. The bridge talks to Slack through one small interface, so the daemon is the only part that
would change.

**Why Bun?**
One runtime for the bridge on macOS and Linux, installed with one command. The rest of liaison is bash and python3.

**Does it read my code?**
The session you start in this folder is Claude Code, so whatever you let it read, it reads, and the subagents it
starts read the projects you register. liaison itself sends nothing anywhere except the Slack messages the session
writes. Setup never writes into your own repositories: project facts live under `.liaison/` here and are passed to
subagents in their briefs. Your Slack tokens stay in `~/.liaison/.env` and only the daemon reads them.

**What does unattended mean?**
It is the permission mode you pick in setup. `supervised` (the default) leaves Claude Code's permission prompts on.
`unattended` adds a `liaison-coordinator` alias that starts `claude` with `--dangerously-skip-permissions`, so the
session never stops to ask at the terminal; the coordinator skill then holds itself to stricter rules about what
needs your approval. Use it on a machine you are comfortable letting run on its own.

**How much does waiting cost?**
Zero tokens. `slack-wait` is a shell process; the model is not running while it sleeps. The session pays only when
a message wakes it.

**Can I use another chat tool?**
Not in v1. Slack is the only transport.

**Can I use another coding agent?**
The Claude-specific parts sit in `engines/claude/`, behind a short contract (install instructions and hooks, launch
a session, place skills, shell aliases) described in [engines/claude/README.md](../engines/claude/README.md). Another
engine means a new folder with those four things. Only `engines/claude/` exists today.

**What if setup fails halfway?**
Run `./setup` again. Every step checks whether it is already done and skips if so. `liaison status` lists each step as
`ok`, `missing` or `skipped`, and the next command to run. `liaison verify` tests the running path.

**How do I add a project?**
`liaison register /path/to/your/repo` for an existing folder, or `liaison new my-app` to create `projects/my-app`
with `git init`. Each project gets its own Slack channel (`#liaison-<name>`) and a facts file in
`.liaison/facts/` for its gate, deploy and rollback commands. `liaison learn <name>` collects its merged PRs,
scripts and README so the coordinator can fill that file for you to check.

**How do I stop everything?**
`liaison daemon stop` stops the bridge, and `liaison advanced disable` stops any departments. If setup installed an
autostart service, remove it too (see Uninstall in the [README](../README.md)), otherwise the system restarts the
daemon. Close the Claude Code session to stop the coordinator.

**What is a handoff?**
A file, `.liaison/handoff/HANDOFF.md`, whose first block (STATE NOW) says what the owner asked for, what is in
progress, the queue, the exact commands, the open questions and the rollbacks. The coordinator rewrites it at every
milestone and keeps it short; detail goes to an append-only log beside it. After a restart or a compaction, a fresh
session reads it and continues, so nothing important lives only in a conversation.
