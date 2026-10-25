#!/bin/bash
# Fails (exit 1) if shipped code or docs contain a leak pattern. Two layers:
#   1. Generic patterns, inline below: absolute home paths, the old bridge's data dir and env prefix, email addresses,
#      (except the commit-trailer address noreply@anthropic.com) and Slack member ids (case-sensitive, whole word, so base64 blobs do not match).
#   2. The maintainer's private deny-list, one extended regex per line (# comments allowed), read from
#      ${LIAISON_AUDIT_TERMS:-$HOME/.liaison/audit-terms}. It lives outside the repo on purpose and is matched
#      case-insensitively; a line carries its own word boundaries. Without the file, only layer 1 runs.
# Skipped: .git, node_modules, .superpowers, __pycache__ (bytecode embeds absolute paths), LICENSE, this script, and
# lockfiles (bun.lock, package-lock.json) for the email and id patterns. docs/superpowers/ is scanned like the rest.
# LIAISON_AUDIT_ROOT overrides the tree to scan (tests).
cd "${LIAISON_AUDIT_ROOT:-$(dirname "$0")/..}" || exit 2

EXCL=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.superpowers --exclude-dir=__pycache__
      --exclude=LICENSE --exclude=audit-leaks.sh)
LOCKS=(--exclude=bun.lock --exclude=package-lock.json)

hits=""
add() { [ -z "$1" ] || hits="${hits:+$hits
}$1"; }

add "$(grep -rniE '/Users/|\.slack-bridge|SLACK_BRIDGE_' "${EXCL[@]}" . 2>/dev/null)"
add "$(grep -rnE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "${EXCL[@]}" "${LOCKS[@]}" . 2>/dev/null | grep -v 'noreply@anthropic\.com')"
add "$(grep -rnE '\bU0[A-Z0-9]{8,10}\b' "${EXCL[@]}" "${LOCKS[@]}" . 2>/dev/null)"

terms="${LIAISON_AUDIT_TERMS:-$HOME/.liaison/audit-terms}"
if [ -f "$terms" ]; then
  pats="$(mktemp "${TMPDIR:-/tmp}/liaison-audit.XXXXXX")" || exit 2
  grep -vE '^[[:space:]]*(#|$)' "$terms" > "$pats"
  if [ -s "$pats" ]; then add "$(grep -rniE -f "$pats" "${EXCL[@]}" . 2>/dev/null)"; fi
  rm -f "$pats"
else
  echo "audit-leaks: no private terms file (generic patterns only)"
fi

if [ -n "$hits" ]; then
  echo "audit-leaks: forbidden terms found:"
  echo "$hits"
  exit 1
fi
echo "audit-leaks: clean"
exit 0
