---
name: slack-bridge
description: Use whenever you talk to the owner on Slack - send updates with slack-say, ask decisions with slack-ask, read replies with slack-inbox, wait for the owner at zero cost with slack-wait, mark messages read with slack-ack.
---

# Slack bridge

A local daemon holds the Slack connection. The verbs below only append a line to a file
(`~/.liaison/<project>/outbox.jsonl`) or read one (`~/.liaison/<project>/inbox.jsonl`) and exit. No verb holds a token,
and waiting costs nothing.

Routing comes from the folder you run the verb in: a registered project's folder talks in that project's channel,
any other folder (the office) talks in the office channel. `slack-inbox --path` prints this folder's inbox; the
outbox is the `outbox.jsonl` next to it.
So run every verb from the folder whose channel you mean: the office folder for the coordinator.

## Rules

- Put the text in single quotes: `slack-say 'Deploy done.'`. Double quotes let the shell expand `$`, backticks and
  `!`. For an apostrophe inside the text, close and reopen: `'it'\''s done'`.
- Never claim "sent" from the exit code alone. A send is real when its outbox line exists (see "Verify a send").
- Every question gets `--timeout` and `--default` so nothing hangs on an owner who is away.
- `slack-wait` runs in the background (Bash `run_in_background: true`) and is re-armed after every wake.
- Write to the owner in their language (`language` in `.liaison/config.json`).

## slack-say: tell the owner something

```
slack-say 'PR #12 merged; deploying to staging now.'
slack-say 'Production is down after the deploy; rolling back.' --urgent
slack-say 'Here is the failing log.' --file ./gate.log
slack-say 'Noted, I will use option B.' --thread q_abc123
```

- `--urgent` @mentions the owner. Use it only for something they must see now (an outage, a blocked deploy).
- `--thread <qid>` posts inside a question's thread. `--file <path>` uploads a file (20 MB max) with the text as
  caption.
- Exit codes: 0 queued, 1 failed, 2 bad usage, 4 no office configured (run `liaison setup`).
- It prints `queued -> <project> (<id>)` on stderr. Keep the id to verify the send.

### Verify a send

Find the outbox line by the id slack-say printed and check its text is yours:

```
grep '"id":"say_abc123"' "$(dirname "$(slack-inbox --path)")/outbox.jsonl"
```

No line means nothing was queued: do not say it was sent. Run it from the same folder as the `slack-say`.
If the daemon later fails to deliver, an inbox line with `"kind":"error"` and `"ref_id":"<id>"` appears:

```
grep '"ref_id":"say_abc123"' "$(slack-inbox --path)"
```

If the daemon is down (`liaison daemon status` prints `stopped`), lines wait in the outbox. Start it with
`liaison daemon start` and say "queued, not yet delivered" until it runs.

## slack-ask: ask a decision, never wait in the foreground

```
slack-ask 'Merge PR #12 now?' --type yesno --timeout 30m --default no
slack-ask 'Which first? A = fix the login bug, B = ship the export, C = update the docs' --type buttons --options "A,B,C" --timeout 2h --default A
slack-ask 'Which region?' --type select --options "us-east,eu-west,ap-south" --timeout 1h --default us-east
slack-ask 'Which checks should block a merge?' --type multiselect --options "tests,lint,typecheck" --timeout 1h --default tests
slack-ask 'What is the staging deploy command?' --type text --timeout 1d --default unknown
```

- It prints the question id (`q_...`) on stdout and exits. Write that id in the handoff's "Open questions" with what
  it decides and its default. Then arm `slack-wait` and end the turn; the answer arrives in the inbox.
- `--type buttons` needs `--options` as consecutive letters `A,B,C` (up to `H`) and the question text must explain
  each letter (`A = ...`). For word labels use `--type select`.
- `--timeout` takes `30s`, `30m`, `2h`, `1d`. `--default` must be one of the options (any text for `--type text`).
- An answer applied by the timeout has `"via":"timeout-default"`. Treat it as "no answer, default applied", never as
  the owner's choice, and say so in the next message.
- `--urgent` @mentions the owner on the question. `--replaces <qid>` cancels an earlier question and asks this one.

### Open and stale questions

```
slack-ask --open
slack-ask --cancel q_abc123 --reason 'answered in chat'
```

Run `slack-ask --open` at the start of a session and after each wake. Cancel any question the conversation already
resolved, so the owner never answers something that no longer matters.

## slack-inbox: read what arrived

```
slack-inbox
slack-inbox --question q_abc123
slack-inbox --all
slack-inbox --path
```

- Without flags it prints new lines since the last read and moves the cursor (exit 1 when nothing is new).
- `--question <qid>` shows the lines for one question (the answer is in `text`, `choice` or `choices`).
- `--all` prints every line without moving the cursor. `--path` prints this folder's inbox file.
- Line kinds: `message` (the owner wrote), `answer`, `blocked` (a question cannot be answered), `error` (a send
  failed for good).

## slack-wait: wait for the owner at zero cost

Run it with the Bash tool and `run_in_background: true`, from the office folder:

```
slack-wait
```

- It blocks until the owner writes, prints the new inbox lines, reacts ✅ to each owner message, and exits. You are
  woken once, when it exits.
- After handling the lines, run it again (re-arm). One waiter per inbox: re-arming twice is harmless.
- Check it is armed before ending a turn:

```
slack-wait --status
```

  It prints `armed ...` or `NOT armed`. `NOT armed` means arm it now.
- Several inboxes in one wait: `slack-wait --inbox <inbox path> --inbox <inbox path>`, each path from
  `slack-inbox --path` run in that folder.
- Right after starting it, `--status` can say `NOT armed` before the waiter writes its pid: check once more
  before arming again.

## slack-ack: mark a message read

`slack-wait` already acks owner messages. Use `slack-ack` for a line you read another way (for example with
`slack-inbox`):

```
slack-ack 1729850000.123456
slack-ack --last
```

The argument is the line's `slack_ts`. `--last` acks the newest unacked owner message.

## slack-register: connect a folder to a channel

Projects are registered with `liaison register <path>` (it calls `slack-register` for you). Use `slack-register`
directly only when the setup skill tells you to.
