# liaison — design (2026-10-25)

Public repo: `github.com/ederwii/liaison`. This document moves to `docs/superpowers/specs/2026-10-25-liaison-design.md` inside that repo once it exists.

## 1. Intent

Package the way the author works with Claude Code so any developer can run it on their own product in under an hour: one Claude Code session that acts like a teammate, reachable on Slack, that delegates to subagents, keeps a written handoff so nothing is lost across restarts or context compaction, and ships through a gate → independent review → merge → deploy flow.

Why now: the pieces exist and have months of real operation behind them (Slack bridge, `slack-wait`, handoff + log, context-guard hook, coordinator skill, release recipes, department peers). They are tangled with one company's paths, language and infrastructure. Extracting them cleanly is the only way to share them.

## 2. Who it is for

A developer who already has Claude Code. They may bring an existing product or start from an empty folder. English-speaking community by default; the tool speaks to its owner in the language the owner picks at setup.

## 3. Goals

- **First hour**: clone → `./setup` → open Claude Code in the folder → a greeting arrives in a Slack channel the bot created, asking what to do.
- **Opening the folder is enough**: the session sees the install state (fresh clone, missing tokens, bridge untested, no channel, no project facts) and guides the remaining steps.
- **Two modes**: *simple* (one coordinator session + Slack + handoff + subagents) and *advanced* (departments as tmux peers with a roster and a supervisor), advanced opt-in on top of simple.
- **Learns the environment**: discovers available CLIs and MCP servers, optional onboarding questionnaire, and a routine that reads past PRs/work to produce project facts the session uses from then on.
- **Portable**: macOS and Linux. Claude Code first, with everything Claude-specific isolated in one layer so another engine is an adapter, not a rewrite.
- **Short README**: one screen, "how to start" first.

## 4. Non-goals (v1)

- Dashboards or web UIs (no control dashboard).
- Any chat other than Slack.
- Reward mechanics, decision ledgers, duplicate-question checks, token-cost audits.
- Permission "toolboxes" with root-owned scripts and sudo locks.
- CI/GitHub Actions workflows of any kind.
- Windows (WSL untested; not promised).
- Multi-user identity. One owner, one machine.

## 5. Anti-goals (a failure even if it works)

- Anything specific to the original company leaks: names, paths, channels, policies, rule files in another language. All content is rewritten from scratch in English; nothing is copied with a find-and-replace.
- Any secret or token in the repo, in examples, in tests, or in logs.
- Setup longer than ~10 minutes or more than ~5 prompts.
- A heavy harness: many hooks, daemons, LaunchAgents, hidden state. The dev must be able to read the whole thing in an afternoon.
- The tool speaking a language the owner did not choose.

## 6. Constraints

- Runtime: **Bun** (the bridge already runs on it; one runtime, installs in one line on both OSes). Bash for scripts (bash 4+; macOS ships 3.2 → setup installs or the scripts avoid 4-only features; builder's call, must be tested on stock macOS).
- Required on the dev's machine: git, `claude` CLI, a Slack workspace where they can create an app. `gh` optional (needed for PR learning and the merge recipe).
- The Slack app is created by the dev from the manifest in the repo (Socket Mode, no public URL). Two tokens: bot (`xoxb-`) and app-level (`xapp-`). They live in `~/.liaison/.env`, never in the repo.
- Everything the session must remember lives in files in the repo folder (handoff, log, facts, state), not in hidden engine memory.
- Claude Code's own settings edits are made by `./setup` (run by the dev), not by the session at runtime: the session proposes a one-line command, the dev runs it.

## 7. Shape of the repo

```
liaison/
  README.md                 one screen: what, 3-step start, two modes, where things live
  setup                     the install script (bash), idempotent, re-runnable
  bin/liaison               CLI: status | daemon start|stop|status | verify | discover | learn | new | register | advanced enable
  bridge/                   Slack daemon + verbs (from the private bridge repo, trimmed: say, ask, wait, inbox, ack; other chat providers, reward features and canvas removed)
  skills/
    liaison-setup/          guides the remaining install steps from inside Claude Code
    coordinator/            the work loop
    slack-bridge/           how to use say/ask/wait
    release/                gate → independent review → merge → deploy → smoke, parameterised
  hooks/context-guard.py    context % warnings, handoff-update nudge, blocks ending a turn with no slack-wait armed (coordinator only)
  templates/
    CLAUDE.md               the office folder's CLAUDE.md (installed as ./CLAUDE.md by setup)
    HANDOFF.md, HANDOFF-log.md
    project-facts.md
    AGENT.md                a department identity (advanced)
    roster.json             (advanced)
  engines/claude/           everything Claude-specific: settings.json fragment (hooks + minimal allowlist), skill install paths, launch command, memory conventions, shell aliases
  advanced/
    supervisor              bash: ensures one tmux session per roster entry, revives dead ones, idempotent
    README.md
  docs/                     design, how the pieces fit, FAQ
  .liaison/                 git-ignored runtime: state.json, config.json, facts/, handoff/
  projects/                 git-ignored default home for projects created with `liaison new`
```

**The office folder.** The liaison clone is the *office*: the coordinator session opens here. Projects are separate folders, registered in `.liaison/config.json` (path → name → Slack channel). A dev starting from zero runs `liaison new <name>` (creates `projects/<name>`, git init, registers it). A dev with a product runs `liaison register <path>`. Subagents work inside the project folders (worktrees when the project is git). *My call.*

**Routing and state (my calls, after the builder check).** The bridge resolves a folder's channel from the office registry (`.liaison/config.json`), not from the git root; unregistered folders fall back to the office channel. One inbox per channel under `~/.liaison/inbox/<channel>/`. The coordinator's `slack-wait` listens on the office inbox and every registered project inbox (the verb already accepts several `--inbox`). One `HANDOFF.md` + log for the coordinator, in `.liaison/handoff/`; per-project knowledge goes to `.liaison/facts/<project>.md`. **Setup never writes into the dev's own repos**: no `CLAUDE.md`, `.claude/` or skills are placed there; the coordinator passes project facts to subagents in the brief. `liaison` and `slack-*` reach PATH through symlinks in `~/.local/bin` (setup asks before touching the shell rc).

**Update story (my call).** The repo ships one committed `CLAUDE.md` that branches on whether `.liaison/state.json` exists: with it, the session is in an office and follows the coordinator/setup skills; without it, the session is a contributor working on liaison itself. `.claude/settings.json` is committed with the hooks only; the dev's allowlist and permission choice go to `.claude/settings.local.json`, git-ignored. Everything generated by setup lives under `.liaison/` (git-ignored). `git pull` never conflicts with an install.

## 8. Setup flow (`./setup`)

1. Check prerequisites: git, claude, bun (offer to install bun), gh (optional, report).
2. Ask language (default English). Store in `.liaison/config.json`.
3. Print the Slack app creation steps with the manifest URL/path; wait for the two tokens pasted into the prompt (hidden input). Write `~/.liaison/.env` (mode 600). Ask the dev's Slack user id or resolve it from the token via `users.lookupByEmail`/`auth.test` (builder's call; the allowlist must end up with the owner's id).
4. Start the daemon; offer autostart: launchd plist on macOS, systemd `--user` unit on Linux, or "I'll run `liaison daemon start` myself".
5. Create the office channel (`#liaison-office` by default, name asked), invite the owner, send the greeting: who the bot is, what it can do, "what should I work on?" Mark `greeting_sent` in state.
6. Install the engine layer: `./CLAUDE.md`, `.claude/settings.json` (hooks + allowlist for `liaison`, `slack-*`, read-only git/gh), skills symlinked/copied where Claude Code reads them (project-level, not global). Offer shell aliases `claude3` / `claude5` (300k / 500k auto-compact window) appended to the shell rc after a yes.
7. Write `.liaison/state.json` with each step's result. Print "open Claude Code in this folder".

Every step is skippable and re-runnable; `./setup` on a finished install reports "nothing to do" and `liaison status` shows the same checklist.

## 9. First session (inside Claude Code)

`CLAUDE.md` tells the session: run `liaison status` first; if any step is missing, use `skills/liaison-setup` to walk the owner through it (in the owner's language, on Slack if the bridge works, otherwise in the terminal). When complete:

- `liaison discover` (pure bash, no model) → `.liaison/facts/tools.md`: CLIs found (`gh`, docker, node, python…), `gh auth status`, MCP servers configured in Claude Code (read from its config files), Claude Code version. The session reads this before choosing how to do things.
- Optional onboarding questionnaire via `slack-ask` (≈6 questions: what you're building, stack, how you ship, how chatty reports should be, timezone/working hours, review strictness). Answers → `.liaison/facts/owner.md`.
- `liaison learn <project>`: the CLI only gathers raw material with no model involved (`gh pr list/view --json` for the last N merged PRs, review comments, the scripts and CI files, README) into `.liaison/raw/<project>/`; the coordinator skill then runs a subagent that reads the last N merged PRs (default 30; cost stated up front), the gate/test/deploy scripts, README and CI config, and writes `.liaison/facts/<project>.md`: conventions, gate command, deploy command, places that broke before, open risks. The owner can re-run it; results are reviewable text, not hidden memory.
- Then the coordinator loop starts.

## 10. Coordinator loop (`skills/coordinator`)

Start: read `HANDOFF.md`, arm `slack-wait` in the background, say hello with the three next actions. Work: every read and implementation goes to a subagent with a brief; builder subagent → **independent reviewer subagent** (fresh, never the author, never the coordinator) → merge only on the reviewer's OK → deploy via the project's recipe → smoke → milestone on Slack. Timestamps only from `date -u`. Handoff updated at every milestone and kept under a size cap, with an append-only log for detail. Re-arm `slack-wait` after each wake. Evidence rule in the skill: measured / inferred / assumed, said explicitly.

## 11. Release skill

Parameterised by the project facts: `gate`, `review`, `merge` (`gh pr merge --match-head-commit`), `deploy_staging`, `deploy_prod`, `smoke`, `rollback`. Missing commands → the skill asks the owner once and writes them to the facts file. No GitHub Actions are added or triggered.

## 12. Advanced mode

`liaison advanced enable` creates `advanced/roster.json` from the template (department name, folder, channel, launch command, start prompt, effort), one `AGENT.md` per department, and installs the supervisor as a cron/launchd/systemd timer (asked) or a manual `liaison supervisor run`. Each department is a tmux session running `claude` in its folder; the bridge routes each folder to its own channel. Peers talk through Slack channels and files, not through each other's terminals. `liaison advanced disable` stops everything.

## 12b. Who is the coordinator (my call)

The context-guard hook enforces "no end of turn without `slack-wait` armed" only for a session that registered as coordinator: the coordinator skill's first step runs `liaison guard register` (writes the session id under `.liaison/guard/`), and the hook is a no-op for every other session in the folder (setup walkthrough, contributor work). No global state under `~/.claude`.

## 13. Engine layer contract

`engines/<name>/` must provide: (a) how to install project-level instructions and hooks, (b) how to launch a session in a folder with a prompt (used by the supervisor), (c) where skills go, (d) the shell aliases. Everything outside `engines/` and `skills/` must not mention Claude. Skills are Markdown and may stay engine-neutral in wording. v1 ships `engines/claude/` only.

## 14. Decisions already made

By the author: public repo under `ederwii`; all code, docs, skills and bot messages in English, owner language chosen at setup; simple and advanced modes as above; macOS + Linux; no internals of the original company; short setup; minimal harness; `claude3`/`claude5` aliases; Claude first with an engine layer.

My calls (overridable): name `liaison`; MIT license; Bun as the only runtime; other chat providers, reward features, canvas, dashboards out; office-folder model with registered projects; facts as plain files in `.liaison/facts/`; settings written by `./setup`, not by the session; `#liaison-office` default channel name; PR learning default N=30.

## 15. Left to the builder

- Exact `state.json`/`config.json` schemas.
- How to trim the bridge (which modules go) while keeping its tests green on Bun.
- Bash 3.2 compatibility strategy on macOS.
- Token-free verification command (`liaison verify`): daemon up, channel exists, say → ack round trip.
- Test strategy: bridge tests (existing, bun), `setup` idempotency tests in a temp HOME, a fake-Slack smoke; all local.
- README wording and the greeting text.

## 16. Questions put to the author after the builder check (2026-10-25) — design approved with the recommendations

1. **Permission mode.** Setup asks the dev to choose: *supervised* (Claude Code's normal prompts; the dev is at the terminal) or *unattended* (launch with Claude Code's skip-permissions flag; the tool says plainly what that means). Recommended default: supervised; the coordinator alias for unattended is a separate alias. Answer: accepted as recommended (2026-10-25).
2. **Prod approval default.** Staging deploys automatic; production deploy and rollback ask the owner on Slack with a timeout that defaults to hold; per-project override in facts (`prod_approval: ask|auto`). Answer: accepted as recommended (2026-10-25).
3. **Bridge code.** Copy the existing TypeScript source and tests into the new repo, scrub names/paths/channel prefix/allowlist, drop the other chat providers, reward features and canvas, rewrite docs in English, start with a fresh git history. The "no copy" anti-goal applies to the original company's content, not to the bridge code. Answer: accepted as recommended (2026-10-25).
4. **Live validation.** Builder tests with fakes and in a temp HOME; a real Slack run needs a second Slack app created by the author from the manifest (tokens pasted into `~/.liaison-dev/.env`), so the production bridge is not disturbed. Linux: best effort in a container if docker is present. Repo creation/push by this session under `ederwii` only after the design OK. Answer: accepted as recommended (2026-10-25).
