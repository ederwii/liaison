#!/bin/bash
# liaison verify: the daemon-stopped failure path (stubbed bun) and the offline round trip (--fake, real bun).
REAL_BUN="$(command -v bun 2>/dev/null)"
[ -n "$REAL_BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && REAL_BUN="$HOME/.bun/bin/bun"; }
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"

# --- daemon stopped: the first step fails, nothing else runs -----------------------------------------------------
out="$("$LIAISON" verify 2>&1)"; rc=$?
assert_eq 1 "$rc" "verify with the daemon stopped exits 1"
assert_contains "$out" "verify: daemon not running" "names the failing step"
case "$out" in *"verify: ok"*) assert_eq "no ok line" "$out" "a stopped daemon never prints verify: ok" ;; *) assert_eq 1 1 ;; esac
assert_contains "$out" "liaison daemon start" "points at the fix"

out="$("$LIAISON" verify --bogus 2>&1)"; rc=$?
assert_eq 2 "$rc" "unknown option exits 2"

# --- fake round trip, real bun -----------------------------------------------------------------------------------
if [ -z "$REAL_BUN" ]; then
  echo "skip: bun is not installed on this machine, so the --fake round trip was not run"
else
  PATH="$(dirname "$REAL_BUN"):$PATH"       # real bun ahead of the sandbox's stub (the bridge scripts use `env bun`)
  export PATH
  mkdir -p "$LIAISON_OFFICE"
  mkdir -p "$TMP/tmp"
  out="$(TMPDIR="$TMP/tmp" "$LIAISON" verify --fake 2>&1)"; rc=$?
  assert_eq 0 "$rc" "verify --fake exits 0"
  assert_contains "$out" "verify: daemon ok" "step 1"
  assert_contains "$out" "verify: office ok" "step 2"
  assert_contains "$out" "verify: say ok" "step 3"
  assert_contains "$out" "verify: delivery ok" "step 4"
  case "$out" in *"verify: ok (round trip "*" s)"*) assert_eq 1 1 ;; *) assert_eq "verify: ok (round trip N s)" "$out" "final line" ;; esac
  case "$(printf '%s\n' "$out" | tail -n 1)" in "verify: ok (round trip "*) assert_eq 1 1 ;; *) assert_eq "verify: ok as the last line" "$(printf '%s\n' "$out" | tail -n 1)" "last line" ;; esac
  # The throwaway daemon is gone and nothing leaked into the sandbox's real home or the office folder.
  [ -e "$LIAISON_HOME/daemon.pid" ]; assert_eq 1 $? "--fake leaves no pid file in LIAISON_HOME"
  [ -e "$LIAISON_HOME/projects.yml" ]; assert_eq 1 $? "--fake does not register anything in LIAISON_HOME"
  [ -e "$LIAISON_OFFICE/outbox.jsonl" ]; assert_eq 1 $? "--fake writes nothing into the office folder"
  assert_eq 0 "$(ls -A "$TMP/tmp" | wc -l | tr -d ' ')" "the throwaway root is removed"

  # Real (non --fake) path against a daemon started by `liaison daemon start` on the fake transport.
  export LIAISON_FAKE=1 LIAISON_OWNER_USER_IDS=U_VERIFY LIAISON_PUMP_MS=100
  trap "'$LIAISON' daemon stop >/dev/null 2>&1; rm -rf '$TMP'" EXIT
  "$LIAISON" daemon start >/dev/null 2>&1; assert_eq 0 $? "test daemon starts (real bun, fake transport)"
  out="$("$LIAISON" verify 2>&1)"; rc=$?
  assert_eq 1 "$rc" "daemon up but no office registered exits 1"
  assert_contains "$out" "verify: office not registered" "names the office step"
  LIAISON_ROOT="$LIAISON_HOME" "$REPO_ROOT/bridge/bin/slack-register" --office "$LIAISON_OFFICE" >/dev/null 2>&1
  out="$("$LIAISON" verify 2>&1)"; rc=$?
  assert_eq 0 "$rc" "verify against the running daemon exits 0"
  assert_contains "$out" "verify: ok (round trip" "real path prints the round trip"
  assert_contains "$(cat "$LIAISON_HOME/office/outbox.jsonl")" "liaison verify 20" "the verify line is in the office outbox"

  # A paused office drops posts but still moves the cursor: verify must not call that a delivery.
  chan_id="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["channels"]["liaison-office"])' "$LIAISON_HOME/state.json")"
  printf '{"type":"message","channel":"%s","user":"U_VERIFY","text":"pause","ts":"1700000000.000100"}\n' "$chan_id" >> "$LIAISON_HOME/_fake_in.jsonl"
  i=0
  while [ "$i" -lt 100 ] && ! python3 -c 'import json,sys;sys.exit(0 if "office" in json.load(open(sys.argv[1])).get("paused",{}) else 1)' "$LIAISON_HOME/state.json" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  out="$("$LIAISON" verify 2>&1)"; rc=$?
  assert_eq 1 "$rc" "verify against a paused office exits 1"
  assert_contains "$out" "verify: delivery failed (office is paused" "names the paused office"
  case "$out" in *"verify: ok"*) assert_eq "no ok line" "$out" "a paused office never prints verify: ok" ;; *) assert_eq 1 1 ;; esac
  "$LIAISON" daemon stop >/dev/null 2>&1

  # A daemon that is alive but never delivers: the wait runs out and the step is named.
  sleep 31 &
  STUCK=$!
  disown "$STUCK"
  echo "$STUCK" > "$LIAISON_HOME/daemon.pid"
  ps -p "$STUCK" -o command= | sed -e 's/^[[:space:]]*//' > "$LIAISON_HOME/daemon.pid.cmd"
  rm -f "$LIAISON_HOME/state.json"
  out="$(LIAISON_VERIFY_WAIT_S=2 "$LIAISON" verify 2>&1)"; rc=$?
  kill "$STUCK" 2>/dev/null
  assert_eq 1 "$rc" "a daemon that never delivers exits 1"
  assert_contains "$out" "verify: delivery: the daemon did not pick up" "names the delivery step"
fi

report
