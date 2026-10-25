#!/bin/bash
# liaison status: step order, exit codes, state round-trip, config, dispatcher.
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"

# Fresh sandbox: everything missing.
out="$("$LIAISON" status 2>&1)"; rc=$?
assert_eq 1 "$rc" "fresh status exits 1"
assert_eq "bun: missing" "$(printf '%s\n' "$out" | sed -n 1p)" "first line"
assert_eq "next: ./setup" "$(printf '%s\n' "$out" | tail -n 1)" "last line"
order="$(printf '%s\n' "$out" | sed '$d' | cut -d: -f1 | tr '\n' ' ')"
assert_eq "bun tokens daemon office_channel greeting engine path language projects facts " "$order" "step order"

# state_set bun ok flips only that line.
. "$REPO_ROOT/lib/state.sh"
state_set bun ok
out="$("$LIAISON" status 2>&1)"; rc=$?
assert_eq "bun: ok" "$(printf '%s\n' "$out" | sed -n 1p)" "bun ok after state_set"
assert_eq "tokens: missing" "$(printf '%s\n' "$out" | sed -n 2p)" "tokens still missing"
assert_eq 1 "$rc" "still exit 1"

# state.json shape and state_get.
assert_eq ok "$(state_get bun)" "state_get bun"
assert_eq missing "$(state_get tokens)" "state_get unset step"
state_set tokens skipped "no slack yet"
assert_eq skipped "$(state_get tokens)" "state_get skipped"
assert_contains "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["bun"]["status"],d["bun"]["at"],d["tokens"]["detail"])' "$LIAISON_STATE_DIR/state.json")" "ok 20" "state.json shape"
assert_contains "$("$LIAISON" status 2>&1 | sed -n 2p)" "tokens: skipped" "skipped shown with detail"

# Every step ok/skipped: exit 0 and the final hint. A recorded-ok daemon only counts while a daemon is alive (I5).
for s in tokens daemon office_channel greeting engine path language projects facts; do state_set "$s" ok; done
state_set facts skipped
out="$(PATH="$HOME/.local/bin:$PATH" "$LIAISON" status 2>&1)"; rc=$?
assert_eq 1 "$rc" "I5: daemon recorded ok but not running exits 1"
assert_contains "$out" "daemon: not running (liaison daemon start)" "I5: stale daemon ok is reported"
case "$out" in *"daemon: ok"*) assert_eq "no daemon: ok" "$out" "I5: no daemon: ok line" ;; *) assert_eq 1 1 ;; esac
assert_eq "next: liaison daemon start" "$(printf '%s\n' "$out" | tail -n 1)" "I5: next step is the daemon"
mkdir -p "$LIAISON_HOME"
sleep 60 & DPID=$!
trap 'kill $DPID 2>/dev/null; rm -rf "$TMP"' EXIT
echo "$DPID" > "$LIAISON_HOME/daemon.pid"
ps -p "$DPID" -o command= | sed -e 's/^[[:space:]]*//' > "$LIAISON_HOME/daemon.pid.cmd"
out="$(PATH="$HOME/.local/bin:$PATH" "$LIAISON" status 2>&1)"; rc=$?
assert_eq 0 "$rc" "all ok|skipped exits 0"
assert_eq "next: open Claude Code in this folder" "$(printf '%s\n' "$out" | tail -n 1)" "final hint"

# The path step is checked live: recorded ok, but ~/.local/bin missing from PATH is not ok.
out="$("$LIAISON" status 2>&1)"; rc=$?
assert_contains "$out" "path: not on PATH" "path not on PATH is reported"
assert_eq 1 "$rc" "path not on PATH exits 1"
assert_contains "$(printf '%s\n' "$out" | tail -n 1)" "add ~/.local/bin to your PATH" "path hint"
out="$(PATH="$HOME/.local/bin:$PATH" "$LIAISON" status 2>&1)"
assert_contains "$out" "path: ok" "path ok when ~/.local/bin is on PATH"

# Config defaults and round-trip.
assert_eq en "$(config_get language)" "default language"
assert_eq liaison-office "$(config_get office_channel)" "default channel"
assert_eq supervised "$(config_get permission_mode)" "default permission_mode"
config_set permission_mode unattended
config_set owner_user_ids '["U1","U2"]'
assert_eq unattended "$(config_get permission_mode)" "config_set string"
assert_eq '["U1","U2"]' "$(config_get owner_user_ids)" "config_set list"
assert_eq en "$(config_get language)" "defaults kept after set"
config_set permission_mode bogus 2>/dev/null; rc=$?
assert_eq 1 "$rc" "config_set rejects a bad permission_mode"
assert_eq unattended "$(config_get permission_mode)" "bad permission_mode left the file untouched"

# Dispatcher.
out="$("$LIAISON" -h 2>&1)"; rc=$?
assert_eq 0 "$rc" "-h exits 0"
for c in status setup daemon verify discover learn new register guard advanced; do assert_contains "$out" "$c" "-h lists $c"; done
out="$("$LIAISON" bogus 2>&1 >/dev/null)"; rc=$?
assert_eq 2 "$rc" "unknown subcommand exits 2"
assert_contains "$out" "usage" "unknown prints usage to stderr"

# Works through a symlink (setup will symlink bin/liaison into PATH).
mkdir -p "$TMP/linkbin"; ln -s "$LIAISON" "$TMP/linkbin/liaison"
unset LIAISON_OFFICE
out="$("$TMP/linkbin/liaison" status 2>&1)"
assert_eq "bun: ok" "$(printf '%s\n' "$out" | sed -n 1p)" "symlinked invocation resolves repo root"

kill "$DPID" 2>/dev/null; wait "$DPID" 2>/dev/null
report
