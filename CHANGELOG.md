# Changelog

## 0.1.1

- setup checks the Slack tokens (auth.test, apps.connections.open) before writing any config or state; a rejection prints Slack's error and records nothing.
- `liaison daemon` keeps the pid when the `.cmd` sidecar is missing, and setup stops a hand-started daemon by pid before the autostart service takes over (`daemon status` says when both exist). `daemon start` refuses to run next to a daemon from an earlier version and prints its pid; `daemon stop` stops it.
- The systemd unit quotes `ExecStart`, adds `%h/.local/bin` to `PATH`, and logs to the journal on systemd older than 240 (no `append:`).
- Setup no longer queues a second greeting while one is pending; a greeting the daemon dropped (paused, or it gave up on it) is re-queued once on the next run, after the daemon is back.
- A token check that gets a non-JSON reply shows what came back and names `LIAISON_SKIP_TOKEN_CHECK=1` (offline installs).
- `liaison verify` cleans up on INT/TERM, and a non-numeric `LIAISON_VERIFY_WAIT_S` warns and uses 20 instead of failing.
- Docs: the context hook needs the office folder (or `LIAISON_STATE_DIR`), the release skill clears a stale prod lock, and `liaison daemon --help` prints to stdout.

## 0.1.0

Initial public release.
