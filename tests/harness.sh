#!/bin/bash
# Test harness shared by tests/*.test.sh. Source it, call make_sandbox, assert, end with `report`.
# bash 3.2 compatible.

HARNESS_FAILS=0
HARNESS_ASSERTS=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

make_sandbox() {
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/liaison-test.XXXXXX")" || exit 2
  TMP="$(cd "$TMP" && pwd -P)"
  trap "rm -rf '$TMP'" EXIT
  mkdir -p "$TMP/home" "$TMP/fake-bin"
  : > "$TMP/calls.log"
  local name
  for name in claude bun slack-say slack-register; do
    printf '#!/bin/bash\necho "$0 $*" >> "%s/calls.log"\nexit 0\n' "$TMP" > "$TMP/fake-bin/$name"
    chmod +x "$TMP/fake-bin/$name"
  done
  # tmux is scriptable: FAKE_TMUX_HAS_SESSION_FILE (if set) is a list of live session names, one per line.
  # `has-session -t X` exits 0 iff X is listed, `new-session -s X` adds X (and removes it again at once when FAKE_TMUX_DIE_AFTER_NEW is set), `kill-session -t X` removes X.
  # Without the file every call exits 0. Every call is logged to calls.log (next to this fake-bin folder).
  cat > "$TMP/fake-bin/tmux" <<'TMUX'
#!/bin/bash
echo "$0 $*" >> "$(dirname "$0")/../calls.log"
f="${FAKE_TMUX_HAS_SESSION_FILE:-}"
verb="${1:-}"
[ $# -gt 0 ] && shift
sess=""
while [ $# -gt 0 ]; do
  case "$1" in
    -t|-s) sess="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$f" ] || exit 0
case "$verb" in
  has-session)  [ -f "$f" ] && grep -qxF -- "$sess" "$f"; exit $? ;;
  new-session)  echo "$sess" >> "$f"
                if [ -n "${FAKE_TMUX_DIE_AFTER_NEW:-}" ]; then grep -vxF -- "$sess" "$f" > "$f.tmp"; mv "$f.tmp" "$f"; fi ;;
  kill-session) if [ -f "$f" ]; then grep -vxF -- "$sess" "$f" > "$f.tmp"; mv "$f.tmp" "$f"; fi ;;
esac
exit 0
TMUX
  chmod +x "$TMP/fake-bin/tmux"
  # gh is scriptable: FAKE_GH_OUTPUT_FILE is cat'ed for every call, FAKE_GH_VIEW_FILE (if set) for `gh pr view`,
  # FAKE_GH_EXIT is the exit code (default 0; FAKE_GH_VIEW_EXIT overrides it for `gh pr view`). `gh auth status` without a file prints the real two-line shape (host, then login). The working directory of each call is appended to $TMP/gh-cwd.log.
  cat > "$TMP/fake-bin/gh" <<GH
#!/bin/bash
echo "\$0 \$*" >> "$TMP/calls.log"
echo "\$PWD" >> "$TMP/gh-cwd.log"
f="\${FAKE_GH_OUTPUT_FILE:-}"
if [ "\$1 \$2" = "pr view" ] && [ -n "\${FAKE_GH_VIEW_FILE:-}" ]; then f="\$FAKE_GH_VIEW_FILE"; fi
if [ -n "\$f" ]; then cat "\$f"
elif [ "\$1 \$2" = "auth status" ]; then printf 'github.com\\n  Logged in to github.com account tester (keyring)\\n  - Active account: true\\n'
fi
if [ "\$1 \$2" = "pr view" ] && [ -n "\${FAKE_GH_VIEW_EXIT:-}" ]; then exit "\$FAKE_GH_VIEW_EXIT"; fi
exit "\${FAKE_GH_EXIT:-0}"
GH
  chmod +x "$TMP/fake-bin/gh"
  # Service managers: log argv, exit code from FAKE_LAUNCHCTL_EXIT / FAKE_SYSTEMCTL_EXIT (default 0).
  printf '#!/bin/bash\necho "$0 $*" >> "%s/calls.log"\nexit "${FAKE_LAUNCHCTL_EXIT:-0}"\n' "$TMP" > "$TMP/fake-bin/launchctl"
  printf '#!/bin/bash\necho "$0 $*" >> "%s/calls.log"\nexit "${FAKE_SYSTEMCTL_EXIT:-0}"\n' "$TMP" > "$TMP/fake-bin/systemctl"
  chmod +x "$TMP/fake-bin/launchctl" "$TMP/fake-bin/systemctl"
  export TMP
  export HOME="$TMP/home"
  export LIAISON_HOME="$TMP/home/.liaison"
  export LIAISON_OFFICE="$TMP/office"   # never the checkout: no test may write into the repo
  mkdir -p "$LIAISON_OFFICE"
  export LIAISON_STATE_DIR="$TMP/state"
  export PATH="$TMP/fake-bin:$PATH"
}

_fail() { # _fail <label> <detail...>
  HARNESS_FAILS=$((HARNESS_FAILS + 1))
  echo "FAIL: $1" >&2
  shift
  printf '  %s\n' "$@" >&2
}

assert_eq() { # assert_eq <expected> <actual> [label]
  HARNESS_ASSERTS=$((HARNESS_ASSERTS + 1))
  if [ "$1" = "$2" ]; then return 0; fi
  _fail "${3:-assert_eq}" "expected: $1" "actual:   $2"
}

assert_contains() { # assert_contains <haystack> <needle> [label]
  HARNESS_ASSERTS=$((HARNESS_ASSERTS + 1))
  case "$1" in
    *"$2"*) return 0 ;;
  esac
  _fail "${3:-assert_contains}" "missing: $2" "in:      $1"
}

_file_mode() {
  if [ "$(uname -s)" = "Darwin" ]; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}

assert_file_mode() { # assert_file_mode <path> <octal> [label]
  HARNESS_ASSERTS=$((HARNESS_ASSERTS + 1))
  local actual
  actual="$(_file_mode "$1" 2>/dev/null)"
  if [ "$actual" = "$2" ]; then return 0; fi
  _fail "${3:-assert_file_mode $1}" "expected mode: $2" "actual mode:   ${actual:-<missing file>}"
}

report() {
  if [ "$HARNESS_FAILS" -gt 0 ]; then
    echo "$HARNESS_FAILS of $HARNESS_ASSERTS assertions failed" >&2
    exit 1
  fi
  echo "ok: $HARNESS_ASSERTS assertions"
  exit 0
}
