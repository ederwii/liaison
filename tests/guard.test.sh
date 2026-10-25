#!/bin/bash
# liaison guard: register / status / unregister the coordinator session for the context-guard hook.
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"
unset CLAUDE_CODE_SESSION_ID
reg="$LIAISON_STATE_DIR/guard/sess-42.json"

out="$("$LIAISON" guard register --handoff "$TMP/handoff.md" --wait "slack-wait --channel office" 2>&1)"; rc=$?
assert_eq 2 "$rc" "register without a session id exits 2"
assert_contains "$out" "CLAUDE_CODE_SESSION_ID" "names the missing variable"
[ ! -e "$reg" ]; assert_eq 0 "$?" "nothing written without a session id"

export CLAUDE_CODE_SESSION_ID=sess-42
out="$("$LIAISON" guard status 2>&1)"; rc=$?
assert_eq 0 "$rc" "status exits 0 when not registered"
assert_eq "not registered" "$out" "status before register"

"$LIAISON" guard register --wait "w" >/dev/null 2>&1
assert_eq 2 "$?" "register needs --handoff"
"$LIAISON" guard register --handoff "$TMP/handoff.md" >/dev/null 2>&1
assert_eq 2 "$?" "register needs --wait"

mkdir -p "$TMP/work"
out="$(cd "$TMP/work" && "$LIAISON" guard register --handoff "$TMP/handoff.md" --wait "slack-wait --channel office" 2>&1)"; rc=$?
assert_eq 0 "$rc" "register exits 0"
[ -f "$reg" ]; assert_eq 0 "$?" "registration file exists"
keys="$(python3 -c 'import json,sys; print(" ".join(sorted(json.load(open(sys.argv[1])))))' "$reg")"
assert_eq "dir handoff registered_at wait" "$keys" "the four keys"
got() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$reg" "$1"; }
assert_eq "$TMP/handoff.md" "$(got handoff)" "handoff"
assert_eq "slack-wait --channel office" "$(got wait)" "wait"
assert_eq "$TMP/work" "$(got dir)" "dir is where register ran"
case "$(got registered_at)" in 20??-??-??T??:??:??Z) ;; *) assert_eq "ISO UTC" "$(got registered_at)" "registered_at format" ;; esac

# A relative handoff is stored as an absolute path.
(cd "$TMP/work" && "$LIAISON" guard register --handoff rel.md --wait w >/dev/null 2>&1)
assert_eq "$TMP/work/rel.md" "$(got handoff)" "relative handoff made absolute"
(cd "$TMP/work" && "$LIAISON" guard register --handoff "$TMP/handoff.md" --wait "slack-wait --channel office" >/dev/null 2>&1)

out="$("$LIAISON" guard status 2>&1)"; rc=$?
assert_eq 0 "$rc" "status exits 0 when registered"
assert_eq "registered (handoff: $TMP/handoff.md, wait: slack-wait --channel office)" "$out" "status after register"

"$LIAISON" guard unregister >/dev/null 2>&1
assert_eq 0 "$?" "unregister exits 0"
[ ! -e "$reg" ]; assert_eq 0 "$?" "registration file removed"
"$LIAISON" guard unregister >/dev/null 2>&1
assert_eq 0 "$?" "unregister is idempotent"
assert_eq "not registered" "$("$LIAISON" guard status 2>&1)" "status after unregister"

"$LIAISON" guard bogus >/dev/null 2>&1
assert_eq 2 "$?" "unknown guard subcommand exits 2"
report
