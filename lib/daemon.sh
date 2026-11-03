#!/bin/bash
# `liaison daemon start|stop|status`: run the Slack bridge detached, tracked by a pid file. Sourced, never executed.
# Needs LIAISON_REPO and LIAISON_HOME (lib/env.sh). bash 3.2 compatible.
#
# Files in $LIAISON_HOME: daemon.pid (the pid), daemon.pid.cmd (that process's command line when it started,
# so a stale pid reused by an unrelated process after a reboot is never signalled; when it is missing the command
# line must contain "run <this repo>/bridge/src/index.ts"), daemon.log.

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
  if [ -f "$(daemon_cmd_file)" ]; then
    recorded="$(cat "$(daemon_cmd_file)")"
    [ -n "$recorded" ] && [ "$(_proc_cmd "$pid")" = "$recorded" ] || return 1
  else
    # The .cmd sidecar is gone (never written, or deleted): still recognise our own daemon by what it runs,
    # so the pid is not forgotten and the process orphaned. An unrelated process that reused the pid does not match.
    case "$(_proc_cmd "$pid")" in *"run $LIAISON_REPO/bridge/src/index.ts"*) ;; *) return 1 ;; esac
  fi
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
    LIAISON_ROOT="$LIAISON_HOME" nohup "$bun" run "$LIAISON_REPO/bridge/src/index.ts" </dev/null >>"$log" 2>&1 &
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
  if pid="$(daemon_live_pid)"; then
    say "running (pid $pid)"
    svc="$(daemon_service_file)"
    if [ -n "$svc" ]; then
      say "note: started by hand, but the autostart service is installed and should own the daemon: run 'liaison daemon stop', then restart the service"
      _daemon_service_hint "$svc"
    fi
    return 0
  fi
  if kind="$(daemon_service_running)"; then say "running (service: $kind)"; return 0; fi
  say "stopped"
  svc="$(daemon_service_file)"
  [ -n "$svc" ] && _daemon_service_hint "$svc"
  return 1
}

# --- autostart service (used by ./setup) ---------------------------------------------------------------

# systemd_version: the major version number of the running systemd, empty when unknown.
systemd_version() {
  systemctl --version 2>/dev/null | sed -n '1s/^systemd[[:space:]]*\([0-9][0-9]*\).*/\1/p'
}

# service_log_target: the systemd StandardOutput value. `append:` needs systemd >= 240; older (or unknown) versions use the journal.
service_log_target() {
  local v
  v="$(systemd_version)"
  case "$v" in
    ''|*[!0-9]*) echo journal ;;
    *) if [ "$v" -ge 240 ]; then echo "append:$LIAISON_HOME/daemon.log"; else echo journal; fi ;;
  esac
}

# render_service_template <template> <out> <bun> <bridge-dir> <home> <liaison-home> <path> [log-target]
render_service_template() {
  local t="$1" out="$2" tmp name val
  tmp="$(mktemp "${TMPDIR:-/tmp}/liaison-render.XXXXXX")" || return 1
  cp "$t" "$tmp" || { rm -f "$tmp"; return 1; }
  for name in BUN BRIDGE_DIR HOME LIAISON_HOME PATH LOG_TARGET; do
    case "$name" in BUN) val="$3" ;; BRIDGE_DIR) val="$4" ;; HOME) val="$5" ;; LIAISON_HOME) val="$6" ;; PATH) val="$7" ;; LOG_TARGET) val="${8:-journal}" ;; esac
    case "$t" in  # plists are XML: escape the three characters that would break the file
      *.plist.tmpl) val="$(printf '%s' "$val" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')" ;;
    esac
    val="$(printf '%s' "$val" | sed -e 's/[\\|&]/\\&/g')"
    sed -e "s|{$name}|$val|g" "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp" || { rm -f "$tmp" "$tmp.next"; return 1; }
  done
  mkdir -p "$(dirname "$out")" && cat "$tmp" > "$out"
  rm -f "$tmp"
}

# autostart_install: renders and loads the service for this platform. Returns 1 when it cannot (caller falls back).
autostart_install() {
  local bun dest tmpl svc_path log_target
  bun="$(daemon_bun_path)" || return 1
  svc_path="$(dirname "$bun"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  if is_macos; then
    command -v launchctl >/dev/null 2>&1 || return 1
    dest="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
    tmpl="$LIAISON_REPO/bridge/service/liaison-bridge.plist.tmpl"
    render_service_template "$tmpl" "$dest" "$bun" "$LIAISON_REPO/bridge" "$HOME" "$LIAISON_HOME" "$svc_path" || { rm -f "$dest"; return 1; }
    launchctl bootout "gui/$(id -u)/$SERVICE_NAME" >/dev/null 2>&1
    launchctl bootstrap "gui/$(id -u)" "$dest" || { rm -f "$dest"; return 1; }
    echo launchd
  else
    command -v systemctl >/dev/null 2>&1 || return 1
    dest="$HOME/.config/systemd/user/$SERVICE_NAME.service"
    tmpl="$LIAISON_REPO/bridge/service/liaison-bridge.service.tmpl"
    log_target="$(service_log_target)"
    render_service_template "$tmpl" "$dest" "$bun" "$LIAISON_REPO/bridge" "$HOME" "$LIAISON_HOME" "$svc_path" "$log_target" || { rm -f "$dest"; return 1; }
    [ "$log_target" = journal ] && echo "liaison: this systemd is older than 240: the daemon log goes to the journal (journalctl --user -u $SERVICE_NAME), not daemon.log" >&2
    systemctl --user daemon-reload && systemctl --user enable --now "$SERVICE_NAME.service" || { rm -f "$dest"; return 1; }
    echo systemd
  fi
}

# daemon_hand_over_to_service: stops a hand-started daemon (by pid) so the autostart service can own the daemon.
# Prints a line when it stopped one; returns 1 when the process would not go away.
daemon_hand_over_to_service() {
  local pid
  pid="$(daemon_live_pid)" || return 0
  daemon_stop >/dev/null 2>&1
  if daemon_live_pid >/dev/null; then echo "liaison: could not stop the hand-started daemon (pid $pid)" >&2; return 1; fi
  say "daemon: stopped the hand-started daemon (pid $pid); the autostart service takes over"
}

daemon_main() {
  case "${1:-}" in
    start)  daemon_start ;;
    stop)   daemon_stop ;;
    status) daemon_status ;;
    -h|--help)  echo "usage: liaison daemon start|stop|status"; return 0 ;;
    "")         echo "usage: liaison daemon start|stop|status" >&2; return 1 ;;
    *)      echo "liaison daemon: unknown action '$1' (start, stop, status)" >&2; return 2 ;;
  esac
}
