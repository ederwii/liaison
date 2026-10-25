#!/bin/bash
# liaison discover: writes .liaison/facts/tools.md. Sourced by bin/liaison, never executed.
# Reads MCP server NAMES only; nothing under a server entry is ever printed.

_tool_version() { # _tool_version <tool>: prints "found <version>" or "missing"
  local t="$1" flag="--version" v
  command -v "$t" >/dev/null 2>&1 || { echo missing; return 0; }
  [ "$t" = tmux ] && flag="-V"
  v="$("$t" $flag 2>&1 | head -n 1)"
  if [ -n "$v" ]; then echo "found $v"; else echo found; fi
}

_mcp_names() { # prints "- name (source)" lines, names only
  LD_HOME_FILE="$HOME/.claude.json" LD_OFFICE_FILE="$LIAISON_OFFICE/.mcp.json" python3 -c '
import json, os
seen = set()
def names(path, label, get):
    try:
        d = json.load(open(path))
    except Exception:
        return
    for srv in get(d):
        if isinstance(srv, dict):
            for k in srv:
                if (k, label) not in seen:
                    seen.add((k, label))
                    print("- %s (%s)" % (k, label))
def home(d):
    out = [d.get("mcpServers")]
    ps = d.get("projects")
    if isinstance(ps, dict):
        out += [p.get("mcpServers") for p in ps.values() if isinstance(p, dict)]
    return out
names(os.environ["LD_HOME_FILE"], "~/.claude.json", home)
names(os.environ["LD_OFFICE_FILE"], ".mcp.json in the office", lambda d: [d.get("mcpServers")])'
}

cmd_discover() {
  local t clis="" github mcp claude_line out="$LIAISON_STATE_DIR/facts/tools.md" line
  [ $# -eq 0 ] || { echo "liaison: usage: liaison discover" >&2; exit 2; }
  command -v python3 >/dev/null 2>&1 || die "python3 is required"
  for t in git gh docker node bun python3 tmux jq; do
    clis="$clis- $t: $(_tool_version "$t")
"
  done
  clis="${clis%?}"
  if command -v gh >/dev/null 2>&1; then
    # Real gh prints the bare host first and the login line second, so pick the line that says it.
    github="$(gh auth status 2>&1)"
    line="$(printf '%s\n' "$github" | grep -i -m 1 'logged in')"
    [ -n "$line" ] || line="$(printf '%s\n' "$github" | head -n 1)"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
    github="- ${line:-not logged in}"
  else
    github="- gh: missing"
  fi
  mcp="$(_mcp_names)"
  [ -n "$mcp" ] || mcp="- none found"
  if command -v claude >/dev/null 2>&1; then
    claude_line="- claude: found $(claude --version 2>&1 | head -n 1)"
  else
    claude_line="- claude: missing"
  fi

  mkdir -p "$LIAISON_STATE_DIR/facts" || die "could not create the facts folder"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "{{CLIS}}")   printf '%s\n' "$clis" ;;
      "{{GITHUB}}") printf '%s\n' "$github" ;;
      "{{MCP}}")    printf '%s\n' "$mcp" ;;
      "{{CLAUDE}}") printf '%s\n' "$claude_line" ;;
      *)            printf '%s\n' "$line" ;;
    esac
  done < "$LIAISON_REPO/templates/tools-facts.md" > "$out.tmp" || die "could not write $out"
  mv "$out.tmp" "$out" || die "could not write $out"
  state_set facts ok "tools.md" || exit 1
  say "wrote $out"
}
