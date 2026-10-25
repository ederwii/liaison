---
name: release
description: Use to ship a reviewed pull request of a registered project - gate, independent review, merge, staging deploy, smoke, production deploy behind the owner's approval, smoke, and a milestone with the rollback command.
---

# Release

Ship one pull request of one project. Every command comes from the project's facts file; nothing is guessed.
Run the steps in order and stop at the first failure.

Folders: `gh` and the project's commands run in the project folder, Slack verbs in the office folder. Run `cd` as
its own Bash call (the folder persists between calls) and `cd <office-path>` again before any Slack verb. Write the
facts file and the handoff with the Edit tool, never with Bash redirects. In supervised mode the gate, deploy,
smoke, `cd` and `gh pr merge` commands prompt at the terminal: tell the owner before each (coordinator skill §7).

## 0. Inputs

- The project name and PR number. The project path is in `.liaison/config.json` (`projects[]`).
- The reviewer's `OK`, reviewed sha and measured gate exit code, when the coordinator already has them.
- The time (`date -u +%Y-%m-%dT%H:%MZ`) and the facts file `.liaison/facts/<project>.md`, read in full with the Read
  tool. From it take: `Gate command`, `Deploy staging`, `Deploy prod`, `prod_approval`, `Smoke`, `Rollback`.

### A missing command

A section that is empty or says `unknown` is missing. Ask the owner once per release, then write the answer into
the facts file:

```
slack-ask '<project>: what is the exact command to deploy to staging? Reply none if there is no staging.' --type text --timeout 1d --default unknown
```

- Put the question id in the handoff's Open questions, arm `slack-wait`, end the turn.
- Answer arrives: write it under its heading in `.liaison/facts/<project>.md` with the Edit tool, as
  `` `<command>` [measured: owner, <date -u time>] ``. `none` means the step is skipped for this project.
- `unknown` (timeout) means stop at this step and report it as ⛔ in the milestone. Do not ask again in this release.

## 1–2. gate and review (one review per head)

Read the current head from the project folder:

```
cd <project-path>
gh pr view <n> --json headRefOid,state,mergeable
cd <office-path>
```

If the coordinator already holds an `OK` from a fresh, independent reviewer (never the builder, never the
coordinator) for this exact `headRefOid`, with the gate exit code 0 that the reviewer measured itself, steps 1–2 are
done: go to step 3. Do not review the same head twice.

Otherwise (no such `OK`, or the head moved since that review) start one fresh reviewer subagent. Brief it with the
PR number, the project path and the facts file, not the builder's conclusion. It must check out the PR head, run the
gate command itself and report its exit code, read the diff against the goal, answer `OK` or `CHANGES`, and state the
head sha it reviewed. `CHANGES` or a red gate: back to a builder, then start again here.

## 3. merge

```
cd <project-path>
gh pr merge <n> --merge --match-head-commit <sha>
gh pr view <n> --json state,mergeCommit
cd <office-path>
```

`--match-head-commit` refuses the merge if the head moved since the review. Merged means `state` is `MERGED`;
record `mergeCommit.oid` as the version (short form: first 7 characters).

## 4. deploy_staging

Skip when the facts say `none`. Otherwise, in the project folder, run the command with its output in a log file
under the office's `.liaison/` and its exit code printed on its own (never behind a pipe):

```
<deploy staging command> > <office-path>/.liaison/<project>-staging.log 2>&1; echo "exit=$?"
tail -n 20 <office-path>/.liaison/<project>-staging.log
```

Non-zero exit: stop and post the milestone with ⛔ and the failing lines quoted from the log.

## 5. smoke (staging)

Run the Smoke command against staging the same way (log file, exit code). A failure stops the release before
production. Production is untouched, so there is no production rollback: report ⛔ with the failing lines, send the
fix back to a builder, and roll staging back only if the owner asks.

## 6. deploy_prod

**One production deploy at a time, across all projects.** The lock is one line in STATE NOW → Now of
`.liaison/handoff/HANDOFF.md`: `prod lock: <project> <version> since <date -u time>`.

1. Look for a `prod lock:` line. A `prod lock:` line whose deploy is not running (no deploy in progress in
   STATE NOW → Now) is stale: clear it and log that in the handoff. If one exists for another release, do not wait:
   post the milestone with ⏳ `Waiting on: production deploy of <other project>`, add this release to STATE NOW → Queue, and go on with other
   work. The next wake checks again.
2. Follow `prod_approval` from the facts file:
   - `ask` (the default; anything other than `auto` counts as `ask`):

```
slack-ask '<project>: deploy <version> to production? Staging smoke passed. Rollback: <rollback command>' --type yesno --timeout 60m --default no
```

     Arm `slack-wait` and end the turn. `yes` from the owner: go on. `no`, or `via: timeout-default`: do not
     deploy; report ⏳ waiting on the owner and keep the release in the Queue.
   - `auto`: go on without asking.
3. Check again that no `prod lock:` line exists, then take the lock: write the line with the Edit tool.
4. Deploy, in the project folder:

```
<deploy prod command> > <office-path>/.liaison/<project>-prod.log 2>&1; echo "exit=$?"
tail -n 20 <office-path>/.liaison/<project>-prod.log
```

## 7. smoke (production)

Run the Smoke command against production (log file, exit code).

- Pass: remove the `prod lock:` line (Edit tool) and post the milestone.
- Fail: keep the lock. Tell the owner at once with `--urgent`, include the exact rollback command, and ask:

```
slack-ask '<project>: production smoke failed after <version>. Roll back with <rollback command>?' --type yesno --urgent --timeout 15m --default no
```

  A rollback is itself a production deploy, run under the same lock. `yes`: run the Rollback command (log file,
  exit code), then the Smoke command again. Remove the lock line only after that, or after the owner says `no` (or
  the timeout applies `no`). Report every result.

## 8. Milestone

Post the coordinator's status list with the version and the exact rollback command, changed rows in bold, then
verify the outbox line (`slack-bridge` skill):

```
slack-say '<project>: <version> is live in production
*✅ Done: PR #<n> merged (<version>), staging and production smoke passed*
🔄 Now: nothing for this release
⏳ Waiting on: none
⛔ Blocked: none
Rollback: <exact rollback command with the previous version>'
```

Record in `.liaison/handoff/HANDOFF.md` (STATE NOW → Rollbacks: project, version, rollback command) and add an entry
at the end of `.liaison/handoff/HANDOFF-log.md` with the `date -u` time, PR, version and smoke exit codes.

## Rules

- Never add, edit or trigger CI workflows (no new files in `.github/workflows/`, no `gh workflow run`). If the project
  deploys from CI on merge, the deploy step is watching that run, not starting one: `gh run list --branch <branch> --limit 3`.
- Never deploy a sha that was not reviewed `OK`. Never skip the smoke.
- Never send deploy logs to Slack, as text or as a file: quote only the failing lines, after checking they hold no
  secrets.
- Every exit code you report is one you saw this turn (measured). Say "inferred" or "assumed" otherwise.
