#!/bin/bash
# Installs the Claude Code engine layer into an office. Usage: install.sh <office>
#   - copies skills/* into <office>/.claude/skills/ (each skill is removed and copied again, so re-runs refresh it)
#   - merges the liaison allowlist into <office>/.claude/settings.local.json (never removes the dev's own entries)
# Skills come from $LIAISON_REPO/skills; LIAISON_SKILLS_SRC overrides that (tests). bash 3.2 compatible.

office="${1:-}"
if [ -z "$office" ]; then echo "usage: install.sh <office>" >&2; exit 2; fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="${LIAISON_REPO:-$(cd "$here/../.." && pwd -P)}"
src="${LIAISON_SKILLS_SRC:-$repo/skills}"
command -v python3 >/dev/null 2>&1 || { echo "liaison: python3 is required" >&2; exit 1; }

mkdir -p "$office/.claude/skills" || exit 1

# --- skills ---------------------------------------------------------------------------------------------
n=0
if [ -d "$src" ]; then
  for d in "$src"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    rm -rf "$office/.claude/skills/$name" || exit 1
    cp -R "${d%/}" "$office/.claude/skills/$name" || exit 1
    n=$((n + 1))
  done
fi
if [ "$n" -eq 0 ]; then echo "engine: no skills to install yet"; else echo "engine: installed $n skill(s) into $office/.claude/skills"; fi

# --- allowlist ------------------------------------------------------------------------------------------
LI_FILE="$office/.claude/settings.local.json" python3 - <<'PY' || exit 1
import json, os, sys

path = os.environ["LI_FILE"]
ALLOW = [
    "Bash(liaison *)", "Bash(slack-say *)", "Bash(slack-ask *)", "Bash(slack-inbox *)", "Bash(slack-wait*)",
    "Bash(bin/liaison *)", "Bash(bridge/bin/slack-*)",
    "Bash(git status*)", "Bash(git log*)", "Bash(git diff*)", "Bash(gh pr view*)", "Bash(gh pr list*)",
]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("top level is not an object")
    except Exception as e:
        sys.stderr.write("liaison: cannot merge into %s (%s); fix or remove it and run again\n" % (path, e))
        sys.exit(1)
perms = data.setdefault("permissions", {})
allow = perms.setdefault("allow", []) if isinstance(perms, dict) else None
if not isinstance(allow, list):
    sys.stderr.write("liaison: %s has an unexpected permissions shape; not touching it\n" % path)
    sys.exit(1)
for entry in ALLOW:
    if entry not in allow:
        allow.append(entry)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
echo "engine: allowlist merged into $office/.claude/settings.local.json"

# The committed hook settings point at $CLAUDE_PROJECT_DIR/hooks, so the office must be the checkout itself.
if [ ! -f "$office/hooks/context-guard.py" ]; then
  echo "engine: note: $office has no hooks/context-guard.py; the context guard needs LIAISON_OFFICE to be the checkout Claude Code opens" >&2
fi
exit 0
