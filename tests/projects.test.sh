#!/bin/bash
# liaison new / register: project folder, slack-register call, config.json projects[], facts file, state.
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"
# The real slack-register needs bun (a stub in the sandbox); point the CLI at the fake-bin stubs and
# assert on calls.log instead.
export LIAISON_BRIDGE_BIN="$TMP/fake-bin"
export LIAISON_OFFICE="$TMP/office"
mkdir -p "$LIAISON_OFFICE"

# new demo
out="$("$LIAISON" new demo 2>&1)"; rc=$?
assert_eq 0 "$rc" "new exits 0"
[ -d "$LIAISON_OFFICE/projects/demo/.git" ]; assert_eq 0 "$?" "projects/demo/.git exists"
assert_contains "$(cat "$TMP/calls.log")" "slack-register $LIAISON_OFFICE/projects/demo demo" "slack-register called with path and name"
cfg="$LIAISON_STATE_DIR/config.json"
assert_eq 1 "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$cfg")" "one project in config"
assert_eq "demo|$LIAISON_OFFICE/projects/demo|liaison-demo" \
  "$(python3 -c 'import json,sys;p=json.load(open(sys.argv[1]))["projects"][0];print("|".join([p["name"],p["path"],p["channel"]]))' "$cfg")" "project entry"
assert_eq en "$(. "$REPO_ROOT/lib/state.sh"; config_get language)" "existing config keys untouched"
facts="$LIAISON_STATE_DIR/facts/demo.md"
[ -f "$facts" ]; assert_eq 0 "$?" "facts file created"
for h in "Gate command" "Deploy staging" "Deploy prod" "Smoke" "Rollback" "Conventions" "Things that broke before" "Open risks" "prod_approval: ask"; do
  assert_contains "$(cat "$facts")" "$h" "facts template has $h"
done
assert_contains "$("$LIAISON" status 2>&1)" "projects: ok" "state projects ok"

# Hand edits to the facts file survive a re-run.
echo "my note" >> "$facts"
out="$("$LIAISON" new demo 2>&1)"; rc=$?
assert_eq 0 "$rc" "re-run exits 0"
assert_contains "$out" "already registered" "re-run says already registered"
assert_eq 1 "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$cfg")" "still one project"
assert_contains "$(cat "$facts")" "my note" "facts file not overwritten"

# new refuses to adopt an existing non-empty folder without .git
mkdir -p "$LIAISON_OFFICE/projects/taken"
echo "precious" > "$LIAISON_OFFICE/projects/taken/file.txt"
out="$("$LIAISON" new taken 2>&1)"; rc=$?
assert_eq 2 "$rc" "new on a non-empty non-git folder exits 2"
assert_contains "$out" "refusing to adopt" "message explains the refusal"
[ ! -e "$LIAISON_OFFICE/projects/taken/.git" ]; assert_eq 0 "$?" "no git init in the foreign folder"
assert_eq 1 "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$cfg")" "refused folder not registered"
# an empty existing folder is fine; a folder that already has .git is fine
mkdir -p "$LIAISON_OFFICE/projects/empty-one"
"$LIAISON" new empty-one >/dev/null 2>&1; assert_eq 0 "$?" "new on an empty folder works"
mkdir -p "$LIAISON_OFFICE/projects/has-git"
git init -q "$LIAISON_OFFICE/projects/has-git"
echo x > "$LIAISON_OFFICE/projects/has-git/f"
"$LIAISON" new has-git >/dev/null 2>&1; assert_eq 0 "$?" "new on a folder that already has .git works"
assert_eq 3 "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$cfg")" "two more projects registered"

# register an existing folder with --name and --channel
mkdir -p "$TMP/other"
out="$("$LIAISON" register "$TMP/other" --name side --channel side-room 2>&1)"; rc=$?
assert_eq 0 "$rc" "register exits 0"
assert_contains "$(cat "$TMP/calls.log")" "slack-register $TMP/other side --channel side-room" "channel passed through"
assert_eq "side-room" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["projects"][3]["channel"])' "$cfg")" "channel stored"

# default name is the folder name
mkdir -p "$TMP/Plain_Dir"
"$LIAISON" register "$TMP/Plain_Dir" >/dev/null 2>&1
assert_eq "plain-dir" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["projects"][4]["name"])' "$cfg")" "default name from folder"

# bad input: exit 2
out="$("$LIAISON" register "$TMP/does-not-exist" 2>&1)"; rc=$?
assert_eq 2 "$rc" "missing path exits 2"
assert_contains "$out" "does-not-exist" "message names the path"
"$LIAISON" register >/dev/null 2>&1; assert_eq 2 "$?" "register without path exits 2"
"$LIAISON" new >/dev/null 2>&1; assert_eq 2 "$?" "new without name exits 2"
"$LIAISON" new "Bad Name" >/dev/null 2>&1; assert_eq 2 "$?" "bad project name exits 2"
[ ! -e "$LIAISON_OFFICE/projects/Bad Name" ]; assert_eq 0 "$?" "bad name creates nothing"

# slack-register collision (exit 3) is reported and nothing is recorded
printf '#!/bin/bash\necho "clash" >&2\nexit 3\n' > "$TMP/fake-bin/slack-register"
mkdir -p "$TMP/clash"
out="$("$LIAISON" register "$TMP/clash" --name clash 2>&1)"; rc=$?
assert_eq 3 "$rc" "collision exits 3"
assert_eq 5 "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["projects"]))' "$cfg")" "collision not recorded"

# register --none: the owner has no project yet; projects counts as skipped, not missing.
fresh_state="$TMP/state-none"
out="$(LIAISON_STATE_DIR="$fresh_state" "$LIAISON" register --none 2>&1)"; rc=$?
assert_eq 0 "$rc" "register --none exits 0"
assert_contains "$out" "projects: skipped" "register --none says so"
assert_eq skipped "$(LIAISON_STATE_DIR="$fresh_state" bash -c '. "$1/lib/state.sh"; state_get projects' _ "$REPO_ROOT")" "projects recorded as skipped"
assert_contains "$(LIAISON_STATE_DIR="$fresh_state" "$LIAISON" status 2>&1)" "projects: skipped (owner has no project yet)" "status shows the skip with its reason"
out="$("$LIAISON" register --none /tmp 2>&1)"; rc=$?
assert_eq 2 "$rc" "register --none with a path is a usage error"

report
