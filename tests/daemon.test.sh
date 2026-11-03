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
assert_contains "$(cat "$TMP/calls.log")" "bun run $REPO_ROOT/bridge/src/index.ts" "bun runs the bridge entry point (absolute path)"
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

# A bun stand-in on PATH (a real bun elsewhere on PATH must not win) that stays a "bun run src/index.ts" process, like the real one.
printf '#!/bin/bash\ntrap "kill \\$!" TERM\nsleep 30 &\nwait\n' > "$TMP/fake-bin/bun"; chmod +x "$TMP/fake-bin/bun"
# (a) The .cmd sidecar going missing must not make the daemon forget its pid: status sees it, stop kills it.
out="$("$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 0 "$rc" "sidecar: start exits 0"
pid="$(cat "$PIDF")"
rm -f "$PIDF.cmd"
assert_eq "running (pid $pid)" "$("$LIAISON" daemon status)" "sidecar missing: status still sees the daemon"
out="$("$LIAISON" daemon start 2>&1)"
assert_contains "$out" "already running (pid $pid)" "sidecar missing: start does not spawn a second daemon"
"$LIAISON" daemon stop >/dev/null 2>&1
kill -0 "$pid" 2>/dev/null; assert_eq 1 $? "sidecar missing: stop kills the daemon by pid"
# the same command shape from another project (pid reuse after a reboot) is not ours either
printf '#!/bin/bash\nexec -a "bun run src/index.ts" sleep 30\n' > "$TMP/other-bun"; chmod +x "$TMP/other-bun"
"$TMP/other-bun" & OTHER=$!; disown "$OTHER"
echo "$OTHER" > "$PIDF"; rm -f "$PIDF.cmd"
"$LIAISON" daemon stop >/dev/null 2>&1
kill -0 "$OTHER" 2>/dev/null; assert_eq 0 $? "sidecar missing: another project's 'run src/index.ts' is never signalled"
kill "$OTHER" 2>/dev/null
echo "$BYSTANDER" > "$PIDF"; rm -f "$PIDF.cmd"
"$LIAISON" daemon stop >/dev/null 2>&1
kill -0 "$BYSTANDER" 2>/dev/null; assert_eq 0 $? "sidecar missing: an unrelated process behind the pid is never signalled"

# A daemon from before this version (command line `bun run src/index.ts`, no .cmd sidecar) is refused, not duplicated.
( cd "$REPO_ROOT/bridge" && exec -a "bun run src/index.ts" sleep 30 ) &
OLD=$!; disown "$OLD"
echo "$OLD" > "$PIDF"; rm -f "$PIDF.cmd"
sleep 0.3
out="$("$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 1 "$rc" "earlier-version daemon: start refuses"
assert_contains "$out" "(pid $OLD)" "earlier-version daemon: start prints its pid"
assert_contains "$out" "liaison daemon stop" "earlier-version daemon: start says how to stop it"
kill -0 "$OLD" 2>/dev/null; assert_eq 0 $? "earlier-version daemon: start left it alone"
out="$("$LIAISON" daemon stop 2>&1)"; rc=$?
assert_eq 0 "$rc" "earlier-version daemon: stop exits 0"
assert_contains "$out" "was pid $OLD" "earlier-version daemon: stop says which pid"
kill -0 "$OLD" 2>/dev/null; assert_eq 1 $? "earlier-version daemon: stop kills it"
# the same command line from another folder is not ours
( cd "$TMP" && exec -a "bun run src/index.ts" sleep 30 ) &
OTHER2=$!; disown "$OTHER2"
echo "$OTHER2" > "$PIDF"; rm -f "$PIDF.cmd"
sleep 0.3
out="$("$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 0 "$rc" "another folder's 'bun run src/index.ts': start is not blocked"
"$LIAISON" daemon stop >/dev/null 2>&1
kill -0 "$OTHER2" 2>/dev/null; assert_eq 0 $? "another folder's 'bun run src/index.ts' survives stop"
kill "$OTHER2" 2>/dev/null

# (b) A hand-started daemon next to an installed autostart service: status says the service should own it.
out="$("$LIAISON" daemon start 2>&1)"; pid="$(cat "$PIDF")"
mkdir -p "$HOME/Library/LaunchAgents"; : > "$HOME/Library/LaunchAgents/liaison-bridge.plist"
out="$(LIAISON_UNAME=Darwin "$LIAISON" daemon status)"; rc=$?
assert_eq 0 "$rc" "hand-started next to a service: exit 0"
assert_contains "$out" "running (pid $pid)" "hand-started next to a service: pid shown"
assert_contains "$out" "started by hand" "hand-started next to a service: status says so"
assert_contains "$out" "launchctl kickstart" "hand-started next to a service: how to restart the service"
rm -f "$HOME/Library/LaunchAgents/liaison-bridge.plist"
"$LIAISON" daemon stop >/dev/null 2>&1


# A daemon that dies immediately is reported, not claimed as running.
printf '#!/bin/bash\nexit 1\n' > "$HOME/.bun/bin/bun"
out="$(PATH=/usr/bin:/bin "$LIAISON" daemon start 2>&1)"; rc=$?
assert_eq 1 "$rc" "start fails when the daemon exits at once"
assert_contains "$out" "daemon.log" "failure points at the log"
[ -e "$PIDF" ]; assert_eq 1 $? "no pid file left behind"

out="$("$LIAISON" daemon --help 2>/dev/null)"; rc=$?
assert_eq 0 "$rc" "daemon --help exits 0"
assert_contains "$out" "usage: liaison daemon" "daemon --help prints to stdout"
out="$("$LIAISON" daemon 2>&1 >/dev/null)"; rc=$?
assert_eq 1 "$rc" "daemon with no action exits 1"
assert_contains "$out" "usage: liaison daemon" "daemon with no action prints usage to stderr"
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
