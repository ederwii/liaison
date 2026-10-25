#!/bin/bash
# liaison learn: raw PR material under .liaison/raw/<name>/, run from the project's folder.
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"
export LIAISON_BRIDGE_BIN="$TMP/fake-bin"
export LIAISON_OFFICE="$TMP/office"
mkdir -p "$LIAISON_OFFICE" "$TMP/proj/scripts"
printf '# Proj\nHello readme\n' > "$TMP/proj/README.md"
printf '{"scripts":{"test":"echo t","deploy":"echo d"}}\n' > "$TMP/proj/package.json"
printf 'all:\n\ttrue\nrelease:\n\ttrue\n' > "$TMP/proj/Makefile"
printf '#!/bin/sh\n' > "$TMP/proj/scripts/ship.sh"
"$LIAISON" register "$TMP/proj" --name proj >/dev/null 2>&1
assert_eq 0 "$?" "register proj"

cat > "$TMP/prs.json" <<'JSON'
[{"number":7,"title":"Add login","body":"Body seven","mergedAt":"2026-01-02T03:04:05Z","files":[{"path":"src/a.ts","additions":1,"deletions":0}]},
 {"number":9,"title":"Fix crash","body":"Body nine","mergedAt":"2026-01-03T03:04:05Z","files":[{"path":"src/b.ts","additions":2,"deletions":1},{"path":"src/c.ts","additions":0,"deletions":3}]}]
JSON
printf 'author: reviewer\nPlease rename x\n' > "$TMP/view.txt"
export FAKE_GH_OUTPUT_FILE="$TMP/prs.json" FAKE_GH_VIEW_FILE="$TMP/view.txt"

out="$("$LIAISON" learn proj --prs 5 2>&1)"; rc=$?
assert_eq 0 "$rc" "learn exits 0"
raw="$LIAISON_STATE_DIR/raw/proj"
for f in prs.json pr-7.md pr-9.md scripts.txt readme.md; do
  [ -f "$raw/$f" ]; assert_eq 0 "$?" "$f exists"
done
assert_eq 5 "$(ls "$raw" | wc -l | tr -d ' ')" "five files"
assert_eq 'next: in Claude Code, run the coordinator skill'"'"'s "learn" recipe' "$(printf '%s\n' "$out" | tail -n 1)" "last line is next:"
assert_contains "$out" "5 files" "prints file count"
pr9="$(cat "$raw/pr-9.md")"
assert_contains "$pr9" "Fix crash" "title"
assert_contains "$pr9" "2026-01-03T03:04:05Z" "merged date"
assert_contains "$pr9" "Body nine" "body"
assert_contains "$pr9" "src/c.ts" "files list"
assert_contains "$pr9" "Please rename x" "comments"
assert_contains "$(cat "$raw/readme.md")" "Hello readme" "readme copied"
sc="$(cat "$raw/scripts.txt")"
assert_contains "$sc" "deploy" "package.json script"
assert_contains "$sc" "release" "Makefile target"
assert_contains "$sc" "ship.sh" "scripts/ file"
calls="$(cat "$TMP/calls.log")"
assert_contains "$calls" "pr list --state merged --limit 5 --json number,title,body,mergedAt,files" "gh pr list args"
assert_contains "$calls" "pr view 7 --comments" "gh pr view args"
assert_eq "$TMP/proj" "$(sort -u "$TMP/gh-cwd.log")" "gh ran inside the project folder"

# default --prs is 30
: > "$TMP/calls.log"
"$LIAISON" learn proj >/dev/null 2>&1
assert_contains "$(cat "$TMP/calls.log")" "--limit 30" "default 30"

# unknown project and bad --prs
out="$("$LIAISON" learn nope 2>&1)"; rc=$?
assert_eq 2 "$rc" "unknown project exits 2"
assert_contains "$out" "nope" "names the project"
"$LIAISON" learn proj --prs abc >/dev/null 2>&1; assert_eq 2 "$?" "bad --prs exits 2"
"$LIAISON" learn >/dev/null 2>&1; assert_eq 2 "$?" "no name exits 2"

# gh pr view failing: marker in the PR file, warning on stderr, still exit 0 (prs.json is valid)
out="$(FAKE_GH_VIEW_EXIT=4 "$LIAISON" learn proj 2>"$TMP/err.txt")"; rc=$?
assert_eq 0 "$rc" "view failure keeps exit 0"
assert_contains "$(cat "$raw/pr-7.md")" "(comments unavailable: gh exit 4)" "marker in pr-7.md"
assert_contains "$(cat "$TMP/err.txt")" "warning" "warning on stderr"
assert_contains "$out" "next: in Claude Code" "next line still printed"

# invalid JSON from gh pr list: non-zero exit, no success lines
printf 'this is not json\n' > "$TMP/bad.json"
out="$(FAKE_GH_OUTPUT_FILE="$TMP/bad.json" "$LIAISON" learn proj 2>&1)"; rc=$?
[ "$rc" -ne 0 ]; assert_eq 0 "$?" "invalid JSON exits non-zero (got $rc)"
case "$out" in *"next:"*|*"wrote "*) assert_eq absent present "no success lines after failure" ;; *) assert_eq 0 0 "no success lines after failure" ;; esac
assert_contains "$out" "valid" "message says the JSON was not valid"
printf '{"not":"a list"}\n' > "$TMP/obj.json"
FAKE_GH_OUTPUT_FILE="$TMP/obj.json" "$LIAISON" learn proj >/dev/null 2>&1
[ "$?" -ne 0 ]; assert_eq 0 "$?" "non-list JSON exits non-zero"

# gh missing
rm -f "$TMP/fake-bin/gh"
out="$(PATH="$TMP/fake-bin:/usr/bin:/bin" "$LIAISON" learn proj 2>&1)"; rc=$?
assert_eq 2 "$rc" "gh missing exits 2"
assert_contains "$out" "gh" "message names gh"

report
