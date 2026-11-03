# Changelog

## 0.1.1

- setup checks the Slack tokens (auth.test, apps.connections.open) before writing any config or state; a rejection prints Slack's error and records nothing.
- `liaison daemon` keeps the pid when the `.cmd` sidecar is missing, and setup stops a hand-started daemon by pid before the autostart service takes over (`daemon status` says when both exist).
- The systemd unit quotes `ExecStart`, adds `%h/.local/bin` to `PATH`, and logs to the journal on systemd older than 240 (no `append:`).
- Setup no longer queues a second greeting when the office is paused or the first delivery errored.
- `liaison verify` cleans up on INT/TERM, and a non-numeric `LIAISON_VERIFY_WAIT_S` warns and uses 20 instead of failing.
- Docs: the context hook needs the office folder (or `LIAISON_STATE_DIR`), the release skill clears a stale prod lock, and `liaison daemon --help` prints to stdout.

## 0.1.0

Initial public release.
