#!/bin/bash
# Checks Slack tokens against the Slack Web API before setup records them. Sourced, never executed. bash 3.2 compatible.
# Tokens are handed to curl on stdin (-K -), never as arguments, so they do not show up in `ps`.
# LIAISON_SKIP_TOKEN_CHECK=1 skips the network check (offline installs); LIAISON_SLACK_API overrides the API base (tests).

# slack_api_call <method> <token>: prints the JSON body. Returns 1 when the request itself failed.
slack_api_call() {
  local method="$1" token="$2"
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS -K - --max-time 20 -X POST "${LIAISON_SLACK_API:-https://slack.com/api}/$method" 2>&1
}

# _slack_error <body>: the "error" field of a Slack reply, else a short generic text.
_slack_error() {
  local e
  e="$(printf '%s' "$1" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  printf '%s' "${e:-unexpected reply}"
}

# slack_check_one <label> <method> <token>: 0 when Slack accepts the token; prints the error to stderr otherwise.
slack_check_one() {
  local label="$1" body
  if ! body="$(slack_api_call "$2" "$3")"; then
    echo "liaison: could not reach Slack to check the $label token (network?). Fix the connection and re-run ./setup, or set LIAISON_SKIP_TOKEN_CHECK=1 to skip the check." >&2
    return 1
  fi
  case "$body" in
    *'"ok":true'*|*'"ok": true'*) return 0 ;;
  esac
  case "$body" in
    *'"error"'*) echo "liaison: Slack rejected the $label token: $(_slack_error "$body")" >&2 ;;
    *) echo "liaison: unexpected reply while checking the $label token (not Slack's JSON; a proxy or a network problem?): $(printf '%s' "$body" | tr '\n' ' ' | cut -c1-200)" >&2
       echo "liaison: fix the connection and re-run ./setup, or set LIAISON_SKIP_TOKEN_CHECK=1 to skip the check." >&2 ;;
  esac
  return 1
}

# slack_check_tokens <bot> <app>: bot token via auth.test, app token via apps.connections.open.
slack_check_tokens() {
  if [ "${LIAISON_SKIP_TOKEN_CHECK:-0}" = 1 ]; then return 0; fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "liaison: curl not found; the Slack tokens were not checked" >&2
    return 0
  fi
  slack_check_one bot auth.test "$1" || return 1
  slack_check_one app apps.connections.open "$2" || return 1
}
