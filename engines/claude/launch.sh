#!/bin/bash
# Launch contract of the Claude Code engine. Sourced by the supervisor, never executed. bash 3.2 compatible.
# Needs config_get (lib/state.sh); it is sourced here when the caller has not done so.

if ! type config_get >/dev/null 2>&1; then
  . "$(dirname "${BASH_SOURCE[0]}")/../../lib/state.sh"
fi

# engine_launch_cmd <dir> <prompt-file> <effort>: prints the command that starts a session.
# The supervisor cd's into <dir> and types the contents of <prompt-file> into the session, so this prints
# only the command line. --dangerously-skip-permissions is added only when permission_mode is unattended.
engine_launch_cmd() {
  local dir="${1:-}" prompt="${2:-}" effort="${3:-}"
  if [ -z "$dir" ] || [ -z "$prompt" ] || [ -z "$effort" ]; then
    echo "usage: engine_launch_cmd <dir> <prompt-file> <effort>" >&2
    return 2
  fi
  if [ "$(config_get permission_mode)" = "unattended" ]; then
    echo "claude --effort $effort --dangerously-skip-permissions"
  else
    echo "claude --effort $effort"
  fi
}

# engine_resume_hint: prints the command that continues the most recent session in the current folder.
engine_resume_hint() {
  echo "claude --continue"
}
