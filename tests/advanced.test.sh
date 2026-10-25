#!/bin/bash
# liaison advanced: enable / run / disable, the roster and the supervisor, against the fake tmux (no real tmux is touched).
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"
export LIAISON_BRIDGE_BIN="$TMP/fake-bin"
export LIAISON_OFFICE="$TMP/office"
mkdir -p "$LIAISON_OFFICE"
export LIAISON_START_DELAY=0
export FAKE_TMUX_HAS_SESSION_FILE="$TMP/sessions"
: > "$FAKE_TMUX_HAS_SESSION_FILE"
roster="$LIAISON_STATE_DIR/roster.json"
dept="$LIAISON_STATE_DIR/departments/engineering"
cfg_advanced() { (. "$REPO_ROOT/lib/state.sh"; config_get advanced); }
count_calls() { grep -c -- "$1" "$TMP/calls.log"; }

assert_eq false "$(cfg_advanced)" "advanced defaults to false"

# enable
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 0 "$rc" "enable exits 0"
[ -f "$roster" ]; assert_eq 0 "$?" "roster.json created"
assert_eq "engineering|True|departments/engineering|liaison-engineering|medium|departments/engineering/START.md" \
  "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]))["departments"][0];print("|".join(str(d[k]) for k in ("name","enabled","dir","channel","effort","start_prompt_file")))' "$roster")" "roster entry"
[ -f "$dept/AGENT.md" ]; assert_eq 0 "$?" "AGENT.md created"
[ -f "$dept/START.md" ]; assert_eq 0 "$?" "START.md created"
for h in Mission Roles KPIs "to be measured" "Inputs" "Outputs" "Autonomy level" L1 L2 L3 L4 "First tasks" Status; do
  assert_contains "$(cat "$dept/AGENT.md")" "$h" "AGENT.md has $h"
done
assert_contains "$(cat "$dept/AGENT.md")" "engineering" "AGENT.md names the department"
assert_contains "$(cat "$dept/START.md")" "You are the engineering department" "START.md prompt"
assert_contains "$(cat "$TMP/calls.log")" "slack-register $dept engineering --channel liaison-engineering" "slack-register called for the department"
assert_eq true "$(cfg_advanced)" "advanced true after enable"
assert_contains "$out" "*/15 * * * *" "enable prints the cron line"
assert_contains "$out" "advanced/README.md" "enable points to the README"

# enable twice: nothing duplicated, hand edits survive
echo "my note" >> "$dept/AGENT.md"
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 0 "$rc" "second enable exits 0"
assert_eq 1 "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["departments"]))' "$roster")" "still one department"
assert_contains "$(cat "$dept/AGENT.md")" "my note" "AGENT.md not overwritten"
assert_eq 1 "$(grep -c 'my note' "$dept/AGENT.md")" "AGENT.md has the note once"

# run twice: started, then running
: > "$TMP/calls.log"
out="$("$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 0 "$rc" "first run exits 0"
assert_contains "$out" "engineering: started" "first run says started"
assert_eq 1 "$(count_calls 'new-session')" "exactly one new-session"
assert_eq 1 "$(count_calls 'send-keys -t liaison-engineering -l')" "exactly one send-keys -l"
assert_eq 1 "$(count_calls 'send-keys -t liaison-engineering Enter')" "exactly one Enter"
assert_contains "$(cat "$TMP/calls.log")" "new-session -d -s liaison-engineering -c $dept claude --effort medium" "new-session shape"
assert_contains "$(cat "$TMP/calls.log")" "-l -- You are the engineering department" "typed the start prompt"
out="$("$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 0 "$rc" "second run exits 0"
assert_contains "$out" "engineering: running" "second run says running"
assert_eq 1 "$(count_calls 'new-session')" "still one new-session after the second run"
assert_eq 0 "$(count_calls 'kill-session')" "run never kills"

# disabled department
python3 - "$roster" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["departments"][0]["enabled"] = False
json.dump(d, open(sys.argv[1], "w"))
PY
: > "$FAKE_TMUX_HAS_SESSION_FILE"; : > "$TMP/calls.log"
out="$("$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 0 "$rc" "run with a disabled department exits 0"
assert_contains "$out" "engineering: disabled" "disabled line"
assert_eq 0 "$(count_calls 'new-session')" "disabled department is not started"

# missing dir: reports, keeps going, exits 1
python3 - "$roster" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["departments"][0]["enabled"] = True
d["departments"].insert(0, dict(d["departments"][0], name="ghost", dir="departments/ghost", channel="liaison-ghost"))
json.dump(d, open(sys.argv[1], "w"))
PY
: > "$TMP/calls.log"
out="$("$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 1 "$rc" "missing dir exits 1"
assert_contains "$out" "ghost: error: dir missing" "missing dir line"
assert_contains "$out" "engineering: started" "later departments still processed"

# disable
: > "$TMP/calls.log"
out="$("$LIAISON" advanced disable 2>&1)"; rc=$?
assert_eq 0 "$rc" "disable exits 0"
assert_contains "$(cat "$TMP/calls.log")" "kill-session -t liaison-engineering" "kill-session for the department"
assert_eq false "$(cfg_advanced)" "advanced false after disable"
assert_eq 0 "$(grep -c '^liaison-engineering$' "$FAKE_TMUX_HAS_SESSION_FILE")" "session gone"

assert_contains "$out" "engineering: stopped" "disable reports stopped"
out="$("$LIAISON" advanced disable 2>&1)"
assert_contains "$out" "engineering: not running" "disable reports not running when there is no session"

# a session that dies right after new-session is an error, not "started"
python3 - "$roster" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["departments"] = d["departments"][1:]
json.dump(d, open(sys.argv[1], "w"))
PY
: > "$FAKE_TMUX_HAS_SESSION_FILE"; : > "$TMP/calls.log"
out="$(FAKE_TMUX_DIE_AFTER_NEW=1 "$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 1 "$rc" "dead session exits 1"
assert_contains "$out" "engineering: error: session died on start" "dead session line"
assert_eq 0 "$(count_calls 'send-keys')" "nothing typed into a dead session"
case "$out" in *started*) assert_eq "no started" "started printed" "dead session is not started" ;; esac

# roster validation in enable (the roster here has one department: engineering)
set_roster() { python3 - "$roster" "$@" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); e = d["departments"][0]
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); e[k] = v
json.dump(d, open(sys.argv[1], "w"))
PY
}
cp "$roster" "$TMP/roster.good"
set_roster effort="high;rm"
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 2 "$rc" "enable rejects a bad effort"
assert_contains "$out" "effort" "bad effort message"
out="$("$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 1 "$rc" "run rejects a bad effort"
assert_contains "$out" "engineering: error: invalid effort" "run bad effort line"
cp "$TMP/roster.good" "$roster"
set_roster dir=
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 2 "$rc" "enable rejects an empty dir"
assert_contains "$out" "dir must not be empty" "empty dir message"
cp "$TMP/roster.good" "$roster"
python3 - "$roster" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["departments"].append(dict(d["departments"][0], name="eng", dir="departments/eng", channel="liaison-eng"))
json.dump(d, open(sys.argv[1], "w"))
PY
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 2 "$rc" "enable rejects a name that is a prefix of another"
assert_contains "$out" "prefixes of each other" "prefix message"
[ ! -d "$LIAISON_STATE_DIR/departments/eng" ]; assert_eq 0 "$?" "nothing created for a rejected roster"
cp "$TMP/roster.good" "$roster"

# I8: an unparsable roster is an error, an empty one is a warning; neither turns advanced on
assert_eq false "$(cfg_advanced)" "I8: advanced is off before the bad-roster cases"
printf '{"departments": [ oops' > "$roster"
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 1 "$rc" "I8: enable on a broken roster exits 1"
assert_contains "$out" "cannot read the roster" "I8: names the parse problem"
case "$out" in *"ready ("*|*"Advanced mode is on"*) assert_eq "no success text" "$out" "I8: broken roster is not reported as success" ;; *) assert_eq 1 1 ;; esac
assert_eq false "$(cfg_advanced)" "I8: advanced stays false for a broken roster"
out="$("$LIAISON" advanced disable 2>&1)"; rc=$?
assert_eq 1 "$rc" "I8: disable on a broken roster exits 1"
printf '{"departments": []}' > "$roster"
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 1 "$rc" "I8: enable on an empty roster exits 1"
assert_contains "$out" "roster has no departments" "I8: warns about the empty roster"
case "$out" in *"Advanced mode is on"*) assert_eq "no success text" "$out" "I8: empty roster is not reported as success" ;; *) assert_eq 1 1 ;; esac
assert_eq false "$(cfg_advanced)" "I8: advanced stays false for an empty roster"
printf '{"departments": "x"}' > "$roster"
out="$("$LIAISON" advanced enable 2>&1)"; rc=$?
assert_eq 1 "$rc" "I8: a roster whose departments is not a list exits 1"
cp "$TMP/roster.good" "$roster"

# config validation
out="$(. "$REPO_ROOT/lib/state.sh"; config_set advanced maybe 2>&1)"; rc=$?
assert_eq 1 "$rc" "config_set advanced rejects junk"

# run without a roster
rm -f "$roster"
out="$("$LIAISON" advanced run 2>&1)"; rc=$?
assert_eq 1 "$rc" "run without roster exits 1"
assert_contains "$out" "liaison advanced enable" "run without roster says what to do"

out="$("$LIAISON" advanced bogus 2>&1)"; rc=$?
assert_eq 2 "$rc" "unknown subcommand exits 2"

report
