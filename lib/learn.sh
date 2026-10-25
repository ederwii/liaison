#!/bin/bash
# liaison learn <name> [--prs N]: raw material for the coordinator's "learn" recipe. No model call.
# Sourced by bin/liaison, never executed.

cmd_learn() {
  local name="" prs=30 path raw n count nums rc
  while [ $# -gt 0 ]; do
    case "$1" in
      --prs) [ $# -ge 2 ] || { echo "liaison: --prs needs a number" >&2; exit 2; }; prs="$2"; shift 2 ;;
      -*)    echo "liaison: unknown option '$1'" >&2; exit 2 ;;
      *)     [ -z "$name" ] || { echo "liaison: usage: liaison learn <name> [--prs N]" >&2; exit 2; }; name="$1"; shift ;;
    esac
  done
  [ -n "$name" ] || { echo "liaison: usage: liaison learn <name> [--prs N]" >&2; exit 2; }
  case "$prs" in ''|*[!0-9]*|0) echo "liaison: --prs must be a positive number, got '$prs'" >&2; exit 2 ;; esac
  command -v gh >/dev/null 2>&1 || { echo "liaison: learn needs the GitHub CLI (gh), and it is not installed. Install it, run 'gh auth login', then retry." >&2; exit 2; }
  path="$(config_project_path "$name")"
  [ -n "$path" ] || { echo "liaison: '$name' is not a registered project (see: liaison register)" >&2; exit 2; }
  [ -d "$path" ] || { echo "liaison: the folder for '$name' is gone: $path" >&2; exit 2; }

  raw="$LIAISON_STATE_DIR/raw/$name"
  mkdir -p "$raw" || die "could not create $raw"
  rm -f "$raw"/pr-*.md

  cd "$path" || die "could not enter $path"
  gh pr list --state merged --limit "$prs" --json number,title,body,mergedAt,files > "$raw/prs.json" \
    || die "gh pr list failed in $path (is gh logged in? try: gh auth status)"
  nums="$(LL_FILE="$raw/prs.json" python3 -c '
import json, os
d = json.load(open(os.environ["LL_FILE"]))
if not isinstance(d, list):
    raise SystemExit("expected a JSON list")
for p in d:
    print(int(p["number"]))')" || die "gh pr list did not return valid PR JSON (see $raw/prs.json)"
  for n in $nums; do
    gh pr view "$n" --comments > "$raw/.comments-$n.txt" 2>/dev/null
    rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "(comments unavailable: gh exit $rc)" > "$raw/.comments-$n.txt"
      echo "liaison: warning: gh pr view $n failed (exit $rc); pr-$n.md has no comments" >&2
    fi
  done
  LL_DIR="$raw" python3 -c '
import json, os
d = os.environ["LL_DIR"]
for p in json.load(open(os.path.join(d, "prs.json"))):
    n = int(p["number"])
    cf = os.path.join(d, ".comments-%d.txt" % n)
    comments = open(cf).read() if os.path.exists(cf) else ""
    files = "\n".join("- " + f.get("path", "") for f in (p.get("files") or []))
    with open(os.path.join(d, "pr-%d.md" % n), "w") as out:
        out.write("# PR #%d: %s\n\nMerged: %s\n\n## Description\n\n%s\n\n## Files\n\n%s\n\n## Comments\n\n%s\n" % (
            n, p.get("title", ""), p.get("mergedAt", ""), p.get("body") or "", files or "(none)", comments.strip() or "(none)"))
    if os.path.exists(cf):
        os.remove(cf)' || die "could not write the PR files in $raw"

  {
    if [ -f package.json ]; then
      echo "## package.json scripts"
      python3 -c '
import json
for k, v in (json.load(open("package.json")).get("scripts") or {}).items():
    print("%s: %s" % (k, v))' 2>/dev/null
    fi
    if [ -f Makefile ]; then
      echo "## Makefile targets"
      sed -n 's/^\([A-Za-z0-9_.-][A-Za-z0-9_.-]*\):\([^=].*\)\{0,1\}$/\1/p' Makefile
    fi
    for n in scripts bin; do
      if [ -d "$n" ]; then
        echo "## $n/"
        ls "$n"
      fi
    done
  } > "$raw/scripts.txt"
  [ -s "$raw/scripts.txt" ] || echo "(no package.json scripts, Makefile targets, or scripts/ and bin/ files found)" > "$raw/scripts.txt"

  n=""
  for f in README.md readme.md README README.rst; do
    [ -f "$f" ] && { n="$f"; break; }
  done
  if [ -n "$n" ]; then cp "$n" "$raw/readme.md"; else echo "(no README found)" > "$raw/readme.md"; fi

  count="$(ls "$raw" | wc -l | tr -d ' ')"
  say "wrote $count files to $raw"
  say "next: in Claude Code, run the coordinator skill's \"learn\" recipe"
}
