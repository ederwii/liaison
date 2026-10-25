#!/bin/bash
# Claude Code engine layer: skills install, settings merge, committed hook settings, launch contract, CLAUDE.md.
. "$(dirname "$0")/harness.sh"
make_sandbox
INSTALL="$REPO_ROOT/engines/claude/install.sh"
OFFICE="$TMP/office"
mkdir -p "$OFFICE"
export LIAISON_REPO="$REPO_ROOT"

pyget() { python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d = d[k]
print(d if isinstance(d, str) else json.dumps(d, sort_keys=True))' "$1" "$2"; }
count_entry() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["permissions"]["allow"].count(sys.argv[2]))' "$1" "$2"; }

# --- no skills source: still succeeds, says so ---------------------------------------------------------
out="$(LIAISON_SKILLS_SRC="$TMP/none" /bin/bash "$INSTALL" "$OFFICE" 2>&1)"; rc=$?
assert_eq 0 "$rc" "install succeeds without a skills folder"
assert_contains "$out" "no skills to install yet" "says there are no skills yet"

# --- skills copy ----------------------------------------------------------------------------------------
SRC="$TMP/skills"
mkdir -p "$SRC/alpha" "$SRC/beta"
echo "alpha v1" > "$SRC/alpha/SKILL.md"
echo "beta v1" > "$SRC/beta/SKILL.md"
export LIAISON_SKILLS_SRC="$SRC"
mkdir -p "$OFFICE/.claude/skills/mine"
echo "dev skill" > "$OFFICE/.claude/skills/mine/SKILL.md"

/bin/bash "$INSTALL" "$OFFICE" >/dev/null 2>&1; rc=$?
assert_eq 0 "$rc" "install exits 0"
assert_eq "$(ls "$SRC" | wc -l | tr -d ' ')" "$(ls "$OFFICE/.claude/skills" | grep -c -v '^mine$')" "copied skill count equals source"
assert_eq "alpha v1" "$(cat "$OFFICE/.claude/skills/alpha/SKILL.md")" "alpha copied"
assert_eq "dev skill" "$(cat "$OFFICE/.claude/skills/mine/SKILL.md")" "the dev's own skill is untouched"

# Re-run after editing: the copy is refreshed, files removed from the source disappear.
echo "alpha v2" > "$SRC/alpha/SKILL.md"
echo "extra" > "$SRC/alpha/notes.md"
/bin/bash "$INSTALL" "$OFFICE" >/dev/null 2>&1
assert_eq "alpha v2" "$(cat "$OFFICE/.claude/skills/alpha/SKILL.md")" "re-run refreshes the edited skill"
assert_eq "extra" "$(cat "$OFFICE/.claude/skills/alpha/notes.md")" "re-run copies new files"
rm "$SRC/alpha/notes.md"
/bin/bash "$INSTALL" "$OFFICE" >/dev/null 2>&1
[ ! -e "$OFFICE/.claude/skills/alpha/notes.md" ]; assert_eq 0 "$?" "re-run drops files removed from the source"

# --- settings.local.json merge --------------------------------------------------------------------------
LOCAL="$OFFICE/.claude/settings.local.json"
printf '%s\n' '{"env": {"KEEP": "1"}, "permissions": {"allow": ["Bash(foo *)"], "deny": ["Bash(rm *)"]}}' > "$LOCAL"
/bin/bash "$INSTALL" "$OFFICE" >/dev/null 2>&1
/bin/bash "$INSTALL" "$OFFICE" >/dev/null 2>&1
assert_eq 1 "$(count_entry "$LOCAL" 'Bash(foo *)')" "the dev's own allow entry is kept"
assert_eq '{"KEEP": "1"}' "$(pyget "$LOCAL" env)" "unrelated keys are kept"
assert_eq '["Bash(rm *)"]' "$(pyget "$LOCAL" permissions.deny)" "deny list is kept"
for e in 'Bash(liaison *)' 'Bash(slack-say *)' 'Bash(slack-ask *)' 'Bash(slack-inbox *)' 'Bash(slack-wait*)' 'Bash(bin/liaison *)' 'Bash(bridge/bin/slack-*)' \
         'Bash(git status*)' 'Bash(git log*)' 'Bash(git diff*)' 'Bash(gh pr view*)' 'Bash(gh pr list*)'; do
  assert_eq 1 "$(count_entry "$LOCAL" "$e")" "allow entry once after two runs: $e"
done
assert_eq 13 "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["permissions"]["allow"]))' "$LOCAL")" "no extra allow entries"

# Fresh office: the file is created.
OFFICE2="$TMP/office2"; mkdir -p "$OFFICE2"
/bin/bash "$INSTALL" "$OFFICE2" >/dev/null 2>&1
assert_eq 1 "$(count_entry "$OFFICE2/.claude/settings.local.json" 'Bash(liaison *)')" "creates settings.local.json when absent"
assert_eq 2 "$(ls "$OFFICE2/.claude/skills" | wc -l | tr -d ' ')" "skills copied into a fresh office"

# Unparseable existing file: refuse, leave it alone.
OFFICE3="$TMP/office3"; mkdir -p "$OFFICE3/.claude"
echo "{ not json" > "$OFFICE3/.claude/settings.local.json"
out="$(/bin/bash "$INSTALL" "$OFFICE3" 2>&1)"; rc=$?
[ "$rc" -ne 0 ]; assert_eq 0 "$?" "install fails on an unparseable settings.local.json"
assert_eq "{ not json" "$(cat "$OFFICE3/.claude/settings.local.json")" "unparseable file is left untouched"

# No office argument.
/bin/bash "$INSTALL" >/dev/null 2>&1
assert_eq 2 "$?" "install without an office argument exits 2"

# --- committed hook settings ----------------------------------------------------------------------------
S="$REPO_ROOT/.claude/settings.json"
python3 -m json.tool "$S" >/dev/null 2>&1; assert_eq 0 "$?" ".claude/settings.json is valid JSON"
assert_eq '["hooks"]' "$(python3 -c 'import json,sys; print(json.dumps(sorted(json.load(open(sys.argv[1])))))' "$S")" "only the hooks key"
assert_eq '["PostToolUse", "SessionStart", "Stop"]' "$(python3 -c 'import json,sys; print(json.dumps(sorted(json.load(open(sys.argv[1]))["hooks"])))' "$S")" "three events"
cmd='python3 "$CLAUDE_PROJECT_DIR/hooks/context-guard.py"'
for ev in PostToolUse Stop SessionStart; do
  assert_eq "$cmd" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hooks"][sys.argv[2]][0]["hooks"][0]["command"])' "$S" "$ev")" "$ev runs the context guard through CLAUDE_PROJECT_DIR"
  assert_eq command "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hooks"][sys.argv[2]][0]["hooks"][0]["type"])' "$S" "$ev")" "$ev hook type"
done
assert_eq compact "$(pyget "$S" hooks.SessionStart | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["matcher"])')" "SessionStart matches compact only"
cmp -s "$S" "$REPO_ROOT/engines/claude/settings.json"; assert_eq 0 "$?" "engines/claude/settings.json fragment matches the committed settings"
[ -f "$REPO_ROOT/hooks/context-guard.py" ]; assert_eq 0 "$?" "the referenced hook exists"

# --- launch contract ------------------------------------------------------------------------------------
. "$REPO_ROOT/lib/state.sh"
. "$REPO_ROOT/engines/claude/launch.sh"
config_set permission_mode supervised
assert_eq "claude --effort high" "$(engine_launch_cmd "$OFFICE" "$TMP/prompt.md" high)" "supervised launch has no skip flag"
config_set permission_mode unattended
assert_eq "claude --effort medium --dangerously-skip-permissions" "$(engine_launch_cmd "$OFFICE" "$TMP/prompt.md" medium)" "unattended launch adds the flag"
rm -f "$LIAISON_STATE_DIR/config.json"
assert_eq "claude --effort low" "$(engine_launch_cmd "$OFFICE" "$TMP/prompt.md" low)" "default mode is supervised"
assert_eq "claude --continue" "$(engine_resume_hint)" "resume hint"
engine_launch_cmd "$OFFICE" "$TMP/prompt.md" >/dev/null 2>&1; [ "$?" -ne 0 ]; assert_eq 0 "$?" "launch without an effort fails"

# --- CLAUDE.md and README -------------------------------------------------------------------------------
M="$REPO_ROOT/CLAUDE.md"
[ -f "$M" ]; assert_eq 0 "$?" "CLAUDE.md exists"
[ "$(wc -l < "$M")" -lt 60 ]; assert_eq 0 "$?" "CLAUDE.md is under 60 lines"
body="$(cat "$M")"
for needle in ".liaison/state.json" "liaison status" "liaison-setup" "coordinator" ".liaison/config.json" "tests/run" "bash 3.2" "audit-leaks"; do
  assert_contains "$body" "$needle" "CLAUDE.md mentions $needle"
done
R="$(cat "$REPO_ROOT/engines/claude/README.md" 2>/dev/null)"
for needle in install.sh launch.sh aliases.sh settings.json LIAISON_OFFICE .claude/skills; do
  assert_contains "$R" "$needle" "engine README mentions $needle"
done

report
