#!/bin/bash
# `liaison daemon start|stop|status`: run the Slack bridge detached, tracked by a pid file. Sourced, never executed.
# Needs LIAISON_REPO and LIAISON_HOME (lib/env.sh). bash 3.2 compatible.
#
# Files in $LIAISON_HOME: daemon.pid (the pid), daemon.pid.cmd (that process's command line when it started,
# so a stale pid reused by an unrelated process after a reboot is never signalled), daemon.log.

SERVICE_NAME="liaison-bridge"

daemon_pid_file() { echo "$LIAISON_HOME/daemon.pid"; }
daemon_cmd_file() { echo "$LIAISON_HOME/daemon.pid.cmd"; }
daemon_log_file() { echo "$LIAISON_HOME/daemon.log"; }

# daemon_bun_path: absolute path of bun even when ~/.bun/bin or ~/.local/bin is not on PATH.
daemon_bun_path() {
  local b
  b="$(command -v bun 2>/dev/null)"
  if [ -z "$b" ] && [ -x "$HOME/.bun/bin/bun" ]; then b="$HOME/.bun/bin/bun"; fi
  [ -n "$b" ] || return 1
  printf '%s\n' "$b"
}

# daemon_service_file: path of the installed autostart unit, empty when there is none.
daemon_service_file() {
  local f
  if is_macos; then f="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"; else f="$HOME/.config/systemd/user/$SERVICE_NAME.service"; fi
  [ -f "$f" ] && printf '%s\n' "$f"
  return 0
}

_proc_cmd() { ps -p "$1" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//'; }

# daemon_live_pid: prints the pid when daemon.pid names a live process that is the one we started.
daemon_live_pid() {
  local pid recorded
  [ -f "$(daemon_pid_file)" ] || return 1
  pid="$(tr -d '[:space:]' < "$(daemon_pid_file)")"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -f "$(daemon_cmd_file)" ] || return 1
  recorded="$(cat "$(daemon_cmd_file)")"
  [ -n "$recorded" ] && [ "$(_proc_cmd "$pid")" = "$recorded" ] || return 1
  printf '%s\n' "$pid"
}

_daemon_forget() { rm -f "$(daemon_pid_file)" "$(daemon_cmd_file)"; }

_daemon_service_hint() {
  local svc="$1"
  if is_macos; then
    say "autostart service installed ($svc): use 'launchctl kickstart -k gui/$(id -u)/$SERVICE_NAME' to restart it"
  else
    say "autostart service installed ($svc): use 'systemctl --user restart $SERVICE_NAME' to restart it"
  fi
}

daemon_start() {
  local pid bun log svc
  if pid="$(daemon_live_pid)"; then say "already running (pid $pid)"; return 0; fi
  svc="$(daemon_service_file)"
  if [ -n "$svc" ]; then
    _daemon_service_hint "$svc" >&2
    echo "liaison: not starting a second daemon next to the autostart service" >&2
    return 1
  fi
  bun="$(daemon_bun_path)" || { echo "liaison: bun not found; run ./setup (or: curl -fsSL https://bun.sh/install | bash)" >&2; return 1; }
  _daemon_forget
  ( umask 077; mkdir -p "$LIAISON_HOME" ) || return 1
  log="$(daemon_log_file)"
  (
    umask 077
    cd "$LIAISON_REPO/bridge" || exit 1
    LIAISON_ROOT="$LIAISON_HOME" nohup "$bun" run src/index.ts </dev/null >>"$log" 2>&1 &
    echo "$!" > "$(daemon_pid_file)"
  ) || return 1
  sleep 1                                    # long enough for a bad config to make it exit
  pid="$(tr -d '[:space:]' < "$(daemon_pid_file)" 2>/dev/null)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    _daemon_forget
    echo "liaison: the daemon exited right after starting; see $log" >&2
    return 1
  fi
  _proc_cmd "$pid" > "$(daemon_cmd_file)"
  say "running (pid $pid)"
}

daemon_stop() {
  local pid i svc
  if ! pid="$(daemon_live_pid)"; then
    _daemon_forget
    say "stopped"
    svc="$(daemon_service_file)"
    [ -n "$svc" ] && _daemon_service_hint "$svc"
    return 0
  fi
  kill "$pid" 2>/dev/null
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; fi
  _daemon_forget
  say "stopped (was pid $pid)"
}

# daemon_service_running: true (and prints launchd|systemd) when the autostart service is running the daemon.
# The pid file only covers a daemon started by hand; a service manager keeps its own process.
daemon_service_running() {
  [ -n "$(daemon_service_file)" ] || return 1
  if is_macos; then
    launchctl print "gui/$(id -u)/$SERVICE_NAME" 2>/dev/null | grep -q 'state = running' || return 1
    echo launchd
  else
    systemctl --user is-active --quiet "$SERVICE_NAME.service" 2>/dev/null || return 1
    echo systemd
  fi
}

daemon_status() {
  local pid svc kind
  if pid="$(daemon_live_pid)"; then say "running (pid $pid)"; return 0; fi
  if kind="$(daemon_service_running)"; then say "running (service: $kind)"; return 0; fi
  say "stopped"
  svc="$(daemon_service_file)"
  [ -n "$svc" ] && _daemon_service_hint "$svc"
  return 1
}

daemon_main() {
  case "${1:-}" in
    start)  daemon_start ;;
    stop)   daemon_stop ;;
    status) daemon_status ;;
    -h|--help|"") echo "usage: liaison daemon start|stop|status" >&2; [ -n "${1:-}" ]; return $? ;;
    *)      echo "liaison daemon: unknown action '$1' (start, stop, status)" >&2; return 2 ;;
  esac
}
