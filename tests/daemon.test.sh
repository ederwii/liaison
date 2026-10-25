#!/bin/bash
# liaison daemon start|stop|status: pid file, kill by pid only, idempotent stop.
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"
printf '#!/bin/bash\necho "$0 $*" >> "%s/calls.log"\nexec sleep 30\n' "$TMP" > "$TMP/fake-bin/bun"
chmod +x "$TMP/fake-bin/bun"

# A bystander the daemon commands must never touch.
sleep 31 &
BYSTANDER=$!
disown "$BYSTANDER"
trap "kill $BYSTANDER 2>/dev/null; '$LIAISON' daemon stop >/dev/null 2>&1; rm -rf '$TMP'" EXIT

PIDF="$LIAISON_HOME/daemon.pid"

assert_eq "stopped" "$("$LIAISON" daemon status | head -n 1)" "status before start"
"$LIAISON" daemon status >/dev/null; assert_eq 1 $? "status exits 1 when stopped"

out="$("$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 0 "$rc" "start exits 0"
pid="$(cat "$PIDF" 2>/dev/null)"
case "$pid" in ''|*[!0-9]*) assert_eq "a pid" "'$pid'" "start writes the pid file" ;; *) assert_eq 1 1 ;; esac
assert_contains "$out" "running (pid $pid)" "start reports the pid"
assert_eq "running (pid $pid)" "$("$LIAISON" daemon status)" "status: running"
kill -0 "$pid" 2>/dev/null; assert_eq 0 $? "the daemon process is alive"
assert_contains "$(cat "$TMP/calls.log")" "bun run src/index.ts" "bun runs the bridge entry point"
assert_file_mode "$LIAISON_HOME/daemon.log" 600 "log is private"

out="$("$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 0 "$rc" "second start exits 0"
assert_contains "$out" "already running (pid $pid)" "second start does not spawn another"
assert_eq "$pid" "$(cat "$PIDF")" "pid unchanged"

out="$("$LIAISON" daemon stop 2>&1)"; rc=$?
assert_eq 0 "$rc" "stop exits 0"
assert_contains "$out" "stopped" "stop says stopped"
kill -0 "$pid" 2>/dev/null; assert_eq 1 $? "the daemon process is gone"
kill -0 "$BYSTANDER" 2>/dev/null; assert_eq 0 $? "stop kills exactly that pid, not other sleeps"
[ -e "$PIDF" ]; assert_eq 1 $? "stop removes the pid file"

out="$("$LIAISON" daemon stop 2>&1)"; rc=$?
assert_eq 0 "$rc" "second stop exits 0"
assert_contains "$out" "stopped" "second stop says stopped"

# A stale pid file that names an unrelated live process is not signalled.
echo "$BYSTANDER" > "$PIDF"
out="$("$LIAISON" daemon stop 2>&1)"
kill -0 "$BYSTANDER" 2>/dev/null; assert_eq 0 $? "stale pid file pointing at another process: it survives stop"
assert_contains "$out" "stopped" "stale pid file reads as stopped"
echo "$BYSTANDER" > "$PIDF"
assert_eq "stopped" "$("$LIAISON" daemon status | head -n 1)" "status ignores a pid it did not start"

# bun is found by path even when it is not on PATH.
mkdir -p "$HOME/.bun/bin"
mv "$TMP/fake-bin/bun" "$HOME/.bun/bin/bun"
out="$(PATH=/usr/bin:/bin "$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 0 "$rc" "start finds ~/.bun/bin/bun when PATH lacks bun"
PATH=/usr/bin:/bin "$LIAISON" daemon stop >/dev/null 2>&1

# A daemon that dies immediately is reported, not claimed as running.
printf '#!/bin/bash\nexit 1\n' > "$HOME/.bun/bin/bun"
out="$(PATH=/usr/bin:/bin "$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 1 "$rc" "start fails when the daemon exits at once"
assert_contains "$out" "daemon.log" "failure points at the log"
[ -e "$PIDF" ]; assert_eq 1 $? "no pid file left behind"

out="$("$LIAISON" daemon bogus 2>&1)"; rc=$?
assert_eq 2 "$rc" "unknown action exits 2"

# An autostart service that is running counts as running, even with no pid file.
rm -f "$PIDF"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.config/systemd/user"
: > "$HOME/Library/LaunchAgents/liaison-bridge.plist"
printf '#!/bin/bash\n[ "$1" = print ] && echo "    state = running"\nexit 0\n' > "$TMP/fake-bin/launchctl"
chmod +x "$TMP/fake-bin/launchctl"
out="$(LIAISON_UNAME=Darwin "$LIAISON" daemon status)"; rc=$?
assert_eq "running (service: launchd)" "$out" "macOS: a running launchd service reads as running"
assert_eq 0 "$rc" "macOS: service running exits 0"
printf '#!/bin/bash\nexit 3\n' > "$TMP/fake-bin/launchctl"
out="$(LIAISON_UNAME=Darwin "$LIAISON" daemon status 2>&1)"; rc=$?
assert_contains "$out" "stopped" "macOS: a service that is not running reads as stopped"
assert_eq 1 "$rc" "macOS: service not running exits 1"
rm -f "$HOME/Library/LaunchAgents/liaison-bridge.plist"
: > "$HOME/.config/systemd/user/liaison-bridge.service"
out="$(LIAISON_UNAME=Linux "$LIAISON" daemon status)"; rc=$?
assert_eq "running (service: systemd)" "$out" "Linux: an active systemd unit reads as running"
out="$(LIAISON_UNAME=Linux FAKE_SYSTEMCTL_EXIT=3 "$LIAISON" daemon status 2>&1)"; rc=$?
assert_contains "$out" "stopped" "Linux: an inactive unit reads as stopped"
assert_eq 1 "$rc" "Linux: inactive unit exits 1"

report
