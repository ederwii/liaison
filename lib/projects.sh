#!/bin/bash
# liaison new / register. Sourced by bin/liaison, never executed. bash 3.2 compatible.
# Uses lib/common.sh and lib/state.sh; the bridge verb directory is LIAISON_BRIDGE_BIN or bridge/bin (as in setup).

_bridge_cmd() { printf '%s/%s\n' "${LIAISON_BRIDGE_BIN:-$LIAISON_REPO/bridge/bin}" "$1"; }

_bad_usage() { echo "liaison: $*" >&2; exit 2; }

# Project names match the bridge: lowercase letters and digits joined by single hyphens.
_valid_name() { # _valid_name <name>
  case "$1" in
    ''|-*|*-|*--*|*[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#1}" -le 40 ]
}

# new <name>: projects/<name> under the office, git init, then register.
cmd_new() {
  local name="${1:-}" dir
  [ $# -eq 1 ] || _bad_usage "usage: liaison new <name>"
  _valid_name "$name" || _bad_usage "project names are lowercase letters and digits joined by single hyphens, got '$name'"
  dir="$LIAISON_OFFICE/projects/$name"
  # Never adopt someone's existing folder: a non-empty folder without .git is refused (use `liaison register`),
  # unless this very project is already registered, which keeps `new` idempotent.
  if [ -e "$dir" ] && [ ! -d "$dir/.git" ] && [ "$(config_project_path "$name")" != "$dir" ]; then
    if [ ! -d "$dir" ] || [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
      _bad_usage "$dir already exists and is not a git project; refusing to adopt it. To track it, run: liaison register $dir"
    fi
  fi
  mkdir -p "$dir" || die "could not create $dir"
  if [ ! -d "$dir/.git" ]; then
    command -v git >/dev/null 2>&1 || die "git is required to create a project"
    git init -q "$dir" || die "git init failed in $dir"
  fi
  cmd_register "$dir" --name "$name"
}

# register <path> [--name n] [--channel c]   |   register --none
cmd_register() {
  local path="" name="" chan="" abs rc out got res none=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --none)    none=1; shift ;;
      --name)    [ $# -ge 2 ] || _bad_usage "--name needs a value"; name="$2"; shift 2 ;;
      --channel) [ $# -ge 2 ] || _bad_usage "--channel needs a value"; chan="$2"; shift 2 ;;
      -*)        _bad_usage "unknown option '$1'" ;;
      *)         [ -z "$path" ] || _bad_usage "usage: liaison register <path> [--name n] [--channel c]"; path="$1"; shift ;;
    esac
  done
  if [ "$none" -eq 1 ]; then
    [ -z "$path$name$chan" ] || _bad_usage "liaison register --none takes no other arguments"
    state_set projects skipped "owner has no project yet" || exit 1
    say "projects: skipped (owner has no project yet); run liaison register <path> or liaison new <name> any time"
    return 0
  fi
  [ -n "$path" ] || _bad_usage "usage: liaison register <path> [--name n] [--channel c] | liaison register --none"
  [ -d "$path" ] || _bad_usage "no such folder: $path"
  abs="$(abs_path "$path")"
  if [ -z "$name" ]; then
    name="$(basename "$abs" | tr 'A-Z_ .' 'a-z---')"
  fi
  _valid_name "$name" || _bad_usage "project names are lowercase letters and digits joined by single hyphens, got '$name' (pass --name)"

  if [ -n "$chan" ]; then
    out="$(LIAISON_ROOT="$LIAISON_HOME" "$(_bridge_cmd slack-register)" "$abs" "$name" --channel "$chan" 2>&1)"
  else
    out="$(LIAISON_ROOT="$LIAISON_HOME" "$(_bridge_cmd slack-register)" "$abs" "$name" 2>&1)"
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    [ -n "$out" ] && echo "$out" >&2
    echo "liaison: slack-register failed (exit $rc); nothing was recorded" >&2
    exit "$rc"
  fi
  if [ -z "$chan" ]; then
    got="$(printf '%s\n' "$out" | sed -n 's/^registered .* -> #\([^ ]*\).*/\1/p' | head -n 1)"
    chan="${got:-liaison-$name}"
  fi

  res="$(config_add_project "$name" "$abs" "$chan")" || die "could not update config.json"
  mkdir -p "$LIAISON_STATE_DIR/facts" || die "could not create the facts folder"
  if [ ! -f "$LIAISON_STATE_DIR/facts/$name.md" ]; then
    sed "s/{{name}}/$name/g" "$LIAISON_REPO/templates/project-facts.md" > "$LIAISON_STATE_DIR/facts/$name.md" \
      || die "could not write the facts file"
  fi
  state_set projects ok "$name" || exit 1
  if [ "$res" = exists ]; then
    say "$name: already registered ($abs)"
  else
    say "registered $name -> #$chan ($abs)"
  fi
}
