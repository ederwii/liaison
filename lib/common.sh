#!/bin/bash
# Shared helpers. Sourced, never executed. bash 3.2 compatible; GNU/BSD differences live here only.

die() { echo "liaison: $*" >&2; exit 1; }

say() { printf '%s\n' "$*"; }

# LIAISON_UNAME overrides `uname -s` (tests use it to exercise the Linux branches on a Mac).
is_macos() { [ "${LIAISON_UNAME:-$(uname -s)}" = "Darwin" ]; }

# sed_inplace <sed-script> <file>: portable `sed -i`.
sed_inplace() {
  if is_macos; then sed -i '' "$1" "$2"; else sed -i "$1" "$2"; fi
}

# abs_path <path>: absolute, symlink-resolved path of an existing file or directory.
abs_path() {
  local p="$1" dir
  if command -v realpath >/dev/null 2>&1 && realpath "$p" >/dev/null 2>&1; then
    realpath "$p"
    return
  fi
  # Fallback (stock macOS has no realpath on older releases): resolve links by hand.
  while [ -L "$p" ]; do
    dir="$(cd "$(dirname "$p")" && pwd -P)"
    p="$(readlink "$p")"
    case "$p" in /*) ;; *) p="$dir/$p" ;; esac
  done
  if [ -d "$p" ]; then (cd "$p" && pwd -P)
  else printf '%s/%s\n' "$(cd "$(dirname "$p")" && pwd -P)" "$(basename "$p")"; fi
}
