#!/bin/bash
# scripts/audit-leaks.sh: the private deny-list file, the generic patterns, and a clean repo without the file.
. "$(dirname "$0")/harness.sh"
make_sandbox
AUDIT="$REPO_ROOT/scripts/audit-leaks.sh"
T="$TMP/tree"; mkdir -p "$T"
printf 'nothing to see\n' > "$T/ok.txt"

audit() { LIAISON_AUDIT_ROOT="$T" "$AUDIT" 2>&1; }

# no terms file: a note, generic patterns only, exit 0 on a clean tree and on the repo itself
out="$(LIAISON_AUDIT_TERMS="$TMP/none" audit)"; rc=$?
assert_eq 0 "$rc" "no terms file: clean tree exits 0"
assert_contains "$out" "audit-leaks: no private terms file (generic patterns only)" "no terms file: says so"
out="$(LIAISON_AUDIT_TERMS="$TMP/none" "$AUDIT" 2>&1)"; rc=$?
assert_eq 0 "$rc" "no terms file: the repo is clean on the generic patterns"
assert_eq 1 "$(printf '%s\n' "$out" | grep -c 'no private terms file')" "the note is printed once"

# a terms file: comments are ignored, a hit exits 1 and prints the line, matching is case-insensitive
printf '# comment\n\n\\bbadword\\b\n' > "$TMP/terms"
out="$(LIAISON_AUDIT_TERMS="$TMP/terms" audit)"; rc=$?
assert_eq 0 "$rc" "terms file, clean tree: exit 0"
printf 'this has a BadWord in it\n' > "$T/bad.txt"
out="$(LIAISON_AUDIT_TERMS="$TMP/terms" audit)"; rc=$?
assert_eq 1 "$rc" "terms file, tree with the term: exit 1"
assert_contains "$out" "bad.txt:1:this has a BadWord in it" "the offending line is printed"
rm -f "$T/bad.txt"

# generic patterns, with no terms file
export LIAISON_AUDIT_TERMS="$TMP/none"
AT='@'; printf 'write to someone%sexample.com\n' "$AT" > "$T/mail.txt"
out="$(audit)"; rc=$?
assert_eq 1 "$rc" "an email address is caught"
assert_contains "$out" "someone${AT}example.com" "the email line is printed"
rm -f "$T/mail.txt"
printf 'Co-Authored-By: Claude <noreply@anthropic.com>\n' > "$T/trailer.txt"
audit >/dev/null; assert_eq 0 $? "the commit trailer address is allowed"
rm -f "$T/trailer.txt"
printf 'member %s here\n' "U01ABC""DEFG" > "$T/id.txt"
out="$(audit)"; rc=$?
assert_eq 1 "$rc" "a Slack member id is caught"
rm -f "$T/id.txt"
printf 'sha512-xu0abcdefghijklmnop+u0ABCDEFGHI/AAU0ABCDEFGHIJ= u0abcdefghij\n' > "$T/blob.txt"
audit >/dev/null; assert_eq 0 $? "a base64-looking blob is not a Slack id"
rm -f "$T/blob.txt"
printf 'x%sy.zz\n' "$AT" > "$T/bun.lock"
audit >/dev/null; assert_eq 0 $? "bun.lock is not scanned for emails"
rm -f "$T/bun.lock"
printf 'cd /Us%s/somebody/x\n' "ers" > "$T/path.txt"
audit >/dev/null; assert_eq 1 $? "an absolute home path is caught"

report
