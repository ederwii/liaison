#!/bin/bash
# liaison discover: tools.md sections, MCP server names only, never values.
. "$(dirname "$0")/harness.sh"
make_sandbox
LIAISON="$REPO_ROOT/bin/liaison"
export LIAISON_OFFICE="$TMP/office"
mkdir -p "$LIAISON_OFFICE"

printf 'github.com\n  Logged in to github.com account someone (keyring)\n  - Active account: true\n' > "$TMP/gh-out.txt"
export FAKE_GH_OUTPUT_FILE="$TMP/gh-out.txt"
cat > "$HOME/.claude.json" <<'JSON'
{"mcpServers": {"home-server-x": {"command": "x", "env": {"TOKEN": "s3cr3t"}}},
 "projects": {"/some/where": {"mcpServers": {"nested-one": {"url": "https://example.test/?key=s3cr3t-nested"}}}}}
JSON
cat > "$LIAISON_OFFICE/.mcp.json" <<'JSON'
{"mcpServers": {"office-tool": {"command": "y", "args": ["--token", "s3cr3t-office"]}}}
JSON

out="$("$LIAISON" discover 2>&1)"; rc=$?
assert_eq 0 "$rc" "discover exits 0"
tools="$LIAISON_STATE_DIR/facts/tools.md"
[ -f "$tools" ]; assert_eq 0 "$?" "tools.md written"
body="$(cat "$tools")"
for h in "CLIs" "GitHub" "MCP servers" "Claude Code"; do
  assert_contains "$body" "## $h" "section $h"
done
assert_contains "$body" "git: found" "git found"
assert_contains "$body" "- Logged in to github.com account someone (keyring)" "gh login line (line 2 of real gh output)"
case "$body" in *"- github.com"*) assert_eq absent present "bare host line not used" ;; *) assert_eq 0 0 "bare host line not used" ;; esac
case "$body" in *"Active account"*) assert_eq absent present "only the login line" ;; *) assert_eq 0 0 "only the login line" ;; esac
assert_contains "$body" "home-server-x" "mcp name from ~/.claude.json"
assert_contains "$body" "nested-one" "mcp name from projects.<path>"
assert_contains "$body" "office-tool" "mcp name from .mcp.json"
for secret in s3cr3t s3cr3t-nested s3cr3t-office "example.test"; do
  case "$body$out" in *"$secret"*) assert_eq absent present "no $secret in output" ;; *) assert_eq 0 0 "no $secret in output" ;; esac
done
assert_contains "$body" "claude:" "claude version line"
assert_contains "$("$LIAISON" status 2>&1)" "facts: ok" "state facts ok"

# The fake gh's default `auth status` has the real two-line shape (host first, login second).
unset FAKE_GH_OUTPUT_FILE
"$LIAISON" discover >/dev/null 2>&1
assert_contains "$(cat "$tools")" "- Logged in to github.com account tester (keyring)" "default fake gh shape"

# Missing tools are labelled, not fatal; re-run rewrites in place.
rm -f "$TMP/fake-bin/gh"
out="$(PATH="$TMP/fake-bin:/usr/bin:/bin" "$LIAISON" discover 2>&1)"; rc=$?
assert_eq 0 "$rc" "discover without gh exits 0"
assert_contains "$(cat "$tools")" "gh: missing" "gh missing labelled"
assert_eq 1 "$(grep -c '^## CLIs' "$tools")" "rewritten, not appended"

report
