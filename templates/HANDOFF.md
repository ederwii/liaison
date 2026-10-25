# HANDOFF

Read the STATE NOW block first. It is what a fresh session (after a restart or a compaction) needs to continue
without asking the owner anything. Keep it at most 6000 characters: rewrite it in place, never append to it.
Anything older or more detailed goes to `.liaison/handoff/HANDOFF-log.md` (append-only).

<!-- STATE NOW: start -->
## STATE NOW

### Mandate
<!-- What the owner asked for, in one or two lines, with the date -u time they asked. Their words when possible. -->
- (none yet: waiting for the owner's first request)

### Now
<!-- Updated at every milestone. Time comes from `date -u +%Y-%m-%dT%H:%MZ`, never from memory. -->
- Updated: YYYY-MM-DDTHH:MMZ
- Doing: (nothing yet)
- Last milestone: (none)

### Queue
<!-- Next items, in order. Mark the owner of each: me / subagent (what brief) / owner. -->
1. (empty)

### Exact commands
<!-- Copy-pasteable commands a fresh session will need: gate, deploy, smoke, the PR being reviewed, worktree paths. -->
```
liaison status
```

### Slack wait command
<!-- Run with Bash run_in_background: true. Re-arm after every wake. Never end a turn without it armed. -->
```
slack-wait
```

### Open questions
<!-- Question ids from slack-ask, what each one decides, and its default. Cancel stale ones with slack-ask --cancel <qid>. -->
- (none)

### Rollbacks
<!-- For every deploy still live: project, version/sha, exact rollback command. -->
- (none)
<!-- STATE NOW: end -->
