#!/bin/bash
# slack-wait finds its sibling verbs (slack-inbox, slack-ack, slack-ask) next to itself, even through a symlink and with
# none of them on PATH (the case when ~/.local/bin is not linked).
. "$(dirname "$0")/harness.sh"
make_sandbox

B="$TMP/bridge/bin"; mkdir -p "$B" "$TMP/linkdir" "$TMP/in"
cp "$REPO_ROOT/bridge/bin/slack-wait" "$B/slack-wait"
printf '#!/bin/bash\necho "%s/in/inbox.jsonl"\n' "$TMP" > "$B/slack-inbox"
printf '#!/bin/bash\necho "ack $*" >> "%s/siblings.log"\n' "$TMP" > "$B/slack-ack"
printf '#!/bin/bash\necho "ask $*" >> "%s/siblings.log"\n' "$TMP" > "$B/slack-ask"
chmod +x "$B"/*
ln -s "$B/slack-wait" "$TMP/linkdir/slack-wait"
# a PATH with the basics and jq, but none of the slack-* verbs and no fake-bin
mkdir -p "$TMP/basic"
for t in jq; do ln -s "$(command -v $t)" "$TMP/basic/$t"; done
BASIC_PATH="$TMP/basic:/usr/bin:/bin"

# --status, through the symlink, with no verbs on PATH: resolves the inbox via the sibling slack-inbox.
out="$(PATH="$BASIC_PATH" "$TMP/linkdir/slack-wait" --status 2>&1)"; rc=$?
case "$out" in *"command not found"*) assert_eq "no 'command not found'" "$out" "slack-wait --status finds slack-inbox" ;; *) assert_eq 1 1 ;; esac
assert_eq 1 "$rc" "--status with no waiter exits 1"
assert_contains "$out" "NOT armed $TMP/in/inbox.jsonl" "--status names the inbox the sibling slack-inbox printed"

# the real script in the repo behaves the same way when its siblings are real files (no stubs): --status with an explicit inbox
out="$(PATH="$BASIC_PATH" "$REPO_ROOT/bridge/bin/slack-wait" --status --inbox "$TMP/in/other.jsonl" 2>&1)"; rc=$?
assert_contains "$out" "NOT armed $TMP/in/other.jsonl" "explicit --inbox needs no sibling"

# a message line: the ✅ ack goes to the sibling slack-ack and the thread reminder to the sibling slack-ask
printf '1970-01-01T00:00:00.000Z\n' > "$TMP/in/.last-ts"
printf '{"ts":"2026-10-25T10:00:00.000Z","kind":"message","from":"U1","channel":"C0123456789","slack_ts":"1700000000.000100","text":"hi"}\n' > "$TMP/in/inbox.jsonl"
out="$(PATH="$BASIC_PATH" "$TMP/linkdir/slack-wait" 2>&1)"; rc=$?
assert_eq 0 "$rc" "a new message wakes slack-wait (exit 0)"
case "$out" in *"command not found"*) assert_eq "no 'command not found'" "$out" "wake path finds its siblings" ;; *) assert_eq 1 1 ;; esac
sib="$(cat "$TMP/siblings.log" 2>/dev/null)"
assert_contains "$sib" "ack 1700000000.000100 --channel C0123456789" "slack-ack called next to the script"
assert_contains "$sib" "ask --open --wait-hint" "slack-ask called next to the script"

report
