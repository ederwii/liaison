# Owner questionnaire

Six short questions so the coordinator works the way the owner wants. Every question is optional.
Run each `slack-ask` from the office folder, one at a time: send one, arm `slack-wait` in the background, end the
turn, and send the next one when the answer arrives. Translate the question text (and the option labels) into the
owner's language from `.liaison/config.json` (`language`) before sending; keep the meaning.

Each question times out after a day and falls back to `skip`, so nothing hangs.

## 0. Offer (send first)

```
slack-ask 'I have 6 short questions so I can work your way (about 3 minutes). Answer them now?' --type yesno --timeout 1d --default no
```

`no` (or the timeout): write `.liaison/facts/owner.md` with the single line `skipped: YYYY-MM-DDTHH:MMZ` (from
`date -u`) and stop. The owner can ask for the questionnaire again at any time.

## 1. What you are building

```
slack-ask 'What are you building, in one or two sentences? Reply skip to skip.' --type text --timeout 1d --default skip
```

## 2. Stack

```
slack-ask 'What is your stack (languages, frameworks, hosting, database)? Reply skip to skip.' --type text --timeout 1d --default skip
```

## 3. How you ship

```
slack-ask 'How do you ship today: the test command, how staging and production deploys happen, and who approves production? Reply skip to skip.' --type text --timeout 1d --default skip
```

## 4. How chatty reports should be

```
slack-ask 'How often should I report?' --type select --options "Only milestones and decisions,Milestones plus a short note when work starts,Every step" --timeout 1d --default "Only milestones and decisions"
```

## 5. Timezone and working hours

```
slack-ask 'What is your timezone and your working hours (for example UTC-6, 9:00 to 18:00)? Reply skip to skip.' --type text --timeout 1d --default skip
```

## 6. Review strictness

```
slack-ask 'How strict should code review be before I merge?' --type select --options "Strict: every change reviewed and the gate run by a fresh reviewer,Normal: review code changes and skip docs-only changes,Light: gate only and review on request" --timeout 1d --default "Strict: every change reviewed and the gate run by a fresh reviewer"
```

## Where answers go

Keep progress in the handoff so a restart can resume: under Open questions, one line per question with its
number, question id and, once it arrives, the answer (read with `slack-inbox --question <qid>`: the `text`,
`choice` or `choices` field). After the last answer, write `.liaison/facts/owner.md` once, with the Write tool, in
this shape, one section per question, in the owner's words (`skip` when skipped):

```
# Owner

Answered: YYYY-MM-DDTHH:MMZ

## What I am building
## Stack
## How I ship
## Reports
## Timezone and working hours
## Review strictness
```

An answer that came from the timeout default (`via: timeout-default` in the inbox line) is recorded as
`skip (no answer)`, never as the owner's choice.
