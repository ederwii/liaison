#!/bin/bash
# liaison advanced: departments as tmux peers. Sourced by bin/liaison, never executed. bash 3.2 compatible.
# Uses lib/common.sh, lib/state.sh and _bridge_cmd / _valid_name from lib/projects.sh.
# The roster is $LIAISON_STATE_DIR/roster.json; relative "dir" and "start_prompt_file" values resolve against that folder.

_adv_roster() { echo "$LIAISON_STATE_DIR/roster.json"; }

# _adv_roster_rows <roster> <only-enabled: 1|0>: prints name, dir, channel and effort (separated by the unit separator, so empty fields survive `read`) of each department.
# A roster that cannot be parsed prints the reason on stderr and returns 1 (callers die with it); an empty roster prints nothing.
_adv_roster_rows() {
  _require_python || return 1
  LS_FILE="$1" LS_ONLY_ENABLED="$2" python3 -c '
import json, os, sys
f = os.environ["LS_FILE"]
try:
    data = json.load(open(f))
except Exception as e:
    sys.stderr.write("liaison: cannot read the roster %s: %s\n" % (f, e))
    sys.exit(1)
ds = data.get("departments") if isinstance(data, dict) else None
if not isinstance(ds, list) or not all(isinstance(d, dict) for d in ds):
    sys.stderr.write("liaison: the roster %s must be an object with a \"departments\" list of objects\n" % f)
    sys.exit(1)
for d in ds:
    if os.environ["LS_ONLY_ENABLED"] == "1" and d.get("enabled", True) is not True:
        continue
    print("\x1f".join(str(d.get(k) or ("medium" if k == "effort" else "")).replace("\n", " ") for k in ("name", "dir", "channel", "effort")))'
}

_adv_schedule_help() {
  local bin
  bin="$LIAISON_REPO/bin/liaison"
  cat <<HELP

Advanced mode is on. Nothing is scheduled yet. To keep the departments alive, pick one:
  1. cron:     */15 * * * * $bin advanced run
  2. launchd (macOS) or a systemd timer (Linux): see advanced/README.md
  3. manual:   run '$bin advanced run' whenever you want (it only starts missing sessions)
HELP
}

_adv_enable() {
  local roster name dir channel effort abs out rc prefixed all rows
  mkdir -p "$LIAISON_STATE_DIR" || die "could not create $LIAISON_STATE_DIR"
  roster="$(_adv_roster)"
  if [ ! -f "$roster" ]; then
    cp "$LIAISON_REPO/templates/roster.json" "$roster" || die "could not write $roster"
  fi
  all="$(_adv_roster_rows "$roster" 0)" || die "fix or delete $roster and run again"
  rows="$(_adv_roster_rows "$roster" 1)" || die "fix or delete $roster and run again"
  if [ -z "$rows" ]; then
    echo "liaison: roster has no departments ($roster lists none that are enabled); add one, then run: liaison advanced enable" >&2
    exit 1
  fi
  # tmux -t prefix-matches session names, so no roster name may be a prefix of another one.
  prefixed="$(printf '%s\n' "$all" | cut -d"$(printf '\037')" -f1 | sort | awk 'NR>1 && index($0, prev) == 1 { print prev " / " $0; exit } { prev = $0 }')"
  [ -z "$prefixed" ] || _bad_usage "roster names must not be prefixes of each other (tmux matches session names by prefix): $prefixed"
  while IFS="$(printf '\037')" read -r name dir channel effort; do
    _valid_name "$name" || _bad_usage "department names are lowercase letters and digits joined by single hyphens, got '$name'"
    case "$effort" in
      ''|*[!a-z]*) _bad_usage "department '$name': effort must be lowercase letters, got '$effort'" ;;
    esac
    [ -n "$dir" ] || _bad_usage "department '$name': dir must not be empty"
    case "$channel" in
      ''|*[!a-z0-9_-]*) _bad_usage "department '$name': channel must be lowercase letters, digits, - or _, got '$channel'" ;;
    esac
    case "$dir" in /*) abs="$dir" ;; *) abs="$LIAISON_STATE_DIR/$dir" ;; esac
    mkdir -p "$abs" || die "could not create $abs"
    abs="$(abs_path "$abs")"
    [ -f "$abs/AGENT.md" ] || sed "s/{{name}}/$name/g; s/{{channel}}/$channel/g" "$LIAISON_REPO/templates/AGENT.md" > "$abs/AGENT.md" \
      || die "could not write $abs/AGENT.md"
    [ -f "$abs/START.md" ] || sed "s/{{name}}/$name/g; s/{{channel}}/$channel/g" "$LIAISON_REPO/templates/START.md" > "$abs/START.md" \
      || die "could not write $abs/START.md"
    out="$(LIAISON_ROOT="$LIAISON_HOME" "$(_bridge_cmd slack-register)" "$abs" "$name" --channel "$channel" 2>&1)"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      [ -n "$out" ] && echo "$out" >&2
      echo "liaison: slack-register failed for $name (exit $rc)" >&2
      exit "$rc"
    fi
    say "$name: ready ($abs, #$channel)"
  done <<EOF
$rows
EOF
  config_set advanced true || die "could not update config.json"
  _adv_schedule_help
}

_adv_disable() {
  local roster name dir channel effort all
  roster="$(_adv_roster)"
  if [ -f "$roster" ]; then
    all="$(_adv_roster_rows "$roster" 0)" || die "fix or delete $roster and run again"
    while IFS="$(printf '\037')" read -r name dir channel effort; do
      [ -n "$name" ] || continue
      _valid_name "$name" || continue
      if tmux has-session -t "liaison-$name" >/dev/null 2>&1; then
        tmux kill-session -t "liaison-$name" >/dev/null 2>&1
        say "$name: stopped"
      else
        say "$name: not running"
      fi
    done <<EOF
$all
EOF
  fi
  config_set advanced false || die "could not update config.json"
}

_adv_run() {
  local roster
  roster="$(_adv_roster)"
  [ -f "$roster" ] || die "no roster at $roster; run: liaison advanced enable"
  /bin/bash "$LIAISON_REPO/advanced/supervisor" --once --roster "$roster"
}

advanced_main() {
  case "${1:-}" in
    enable)  shift; [ $# -eq 0 ] || _bad_usage "usage: liaison advanced enable"; _adv_enable ;;
    disable) shift; [ $# -eq 0 ] || _bad_usage "usage: liaison advanced disable"; _adv_disable ;;
    run)     shift; [ $# -eq 0 ] || _bad_usage "usage: liaison advanced run"; _adv_run ;;
    *)       _bad_usage "usage: liaison advanced enable | disable | run" ;;
  esac
}
