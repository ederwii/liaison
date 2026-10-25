#!/bin/bash
# liaison guard register|status|unregister: scope the context-guard hook (hooks/context-guard.py) to this
# Claude Code session. Sourced by bin/liaison, never executed. bash 3.2 compatible.
# A registration is <state dir>/guard/<session id>.json; the hook reads it, this file only writes it.

guard_usage() {
  echo "usage: liaison guard register --handoff <file> --wait \"<command>\" | status | unregister" >&2
}

guard_session_file() { # prints the registration path or exits 2 when there is no session id
  [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || {
    echo "liaison guard: CLAUDE_CODE_SESSION_ID is not set; run this from inside a Claude Code session" >&2
    exit 2
  }
  local id
  id="$(printf '%s' "$CLAUDE_CODE_SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/guard/%s.json\n' "$LIAISON_STATE_DIR" "$id"
}

guard_main() {
  local sub="${1:-}" file handoff="" wait_cmd=""
  [ $# -gt 0 ] && shift
  case "$sub" in
    register)
      while [ $# -gt 0 ]; do
        case "$1" in
          --handoff) [ $# -ge 2 ] || { echo "liaison guard: --handoff needs a file" >&2; exit 2; }; handoff="$2"; shift 2 ;;
          --wait)    [ $# -ge 2 ] || { echo "liaison guard: --wait needs a command" >&2; exit 2; }; wait_cmd="$2"; shift 2 ;;
          *)         echo "liaison guard: unknown option '$1'" >&2; guard_usage; exit 2 ;;
        esac
      done
      file="$(guard_session_file)" || exit $?
      [ -n "$handoff" ] && [ -n "$wait_cmd" ] || { echo "liaison guard: register needs both --handoff and --wait" >&2; guard_usage; exit 2; }
      case "$handoff" in /*) ;; *) handoff="$PWD/$handoff" ;; esac
      mkdir -p "$LIAISON_STATE_DIR/guard" || die "could not create $LIAISON_STATE_DIR/guard"
      LG_FILE="$file" LG_HANDOFF="$handoff" LG_WAIT="$wait_cmd" LG_DIR="$PWD" python3 -c '
import json, os, time
path = os.environ["LG_FILE"]
data = {
    "handoff": os.environ["LG_HANDOFF"],
    "wait": os.environ["LG_WAIT"],
    "dir": os.environ["LG_DIR"],
    "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
with open(path + ".tmp", "w") as f:
    json.dump(data, f)
os.replace(path + ".tmp", path)' || die "could not write $file"
      say "registered (handoff: $handoff, wait: $wait_cmd)"
      ;;
    status)
      file="$(guard_session_file)" || exit $?
      if [ -f "$file" ]; then
        LG_FILE="$file" python3 -c '
import json, os
d = json.load(open(os.environ["LG_FILE"]))
print("registered (handoff: %s, wait: %s)" % (d["handoff"], d["wait"]))' || die "could not read $file"
      else
        say "not registered"
      fi
      ;;
    unregister)
      file="$(guard_session_file)" || exit $?
      rm -f "$file" "${file%.json}.state.json"
      say "not registered"
      ;;
    *)
      guard_usage
      exit 2
      ;;
  esac
}
