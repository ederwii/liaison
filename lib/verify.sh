#!/bin/bash
# `liaison verify [--fake]`: prove the office answers end to end. Sourced by bin/liaison, never executed.
# Needs lib/common.sh, lib/daemon.sh (daemon_live_pid, daemon_bun_path, SERVICE_NAME), lib/projects.sh (_bridge_cmd).
# bash 3.2 compatible.
#
# Steps, in order (each prints `verify: <step> ok`; the first failure prints why and exits 1):
#   1 daemon    the bridge daemon is running
#   2 office    the office is registered (slack-inbox --path resolves from the office folder)
#   3 say       slack-say queues a line in the office outbox
#   4 delivery  the daemon handled that line within 20 s: its saved outbox cursor moved past it and no
#               kind=error line names the id. (The outbox itself is append-only; the daemon records progress in
#               state.json, so that is the place to look.)
# --fake runs the same steps against a throwaway daemon on the bridge's fake transport (no Slack, no tokens).

VERIFY_WAIT_S="${LIAISON_VERIFY_WAIT_S:-20}"   # the env override exists for tests
_VERIFY_TMP=""
_VERIFY_FAKE_PID=""

_verify_fail() { echo "verify: $*" >&2; }

_verify_cleanup() {
  if [ -n "$_VERIFY_FAKE_PID" ]; then
    kill "$_VERIFY_FAKE_PID" 2>/dev/null
    local i=0
    while kill -0 "$_VERIFY_FAKE_PID" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
    kill -9 "$_VERIFY_FAKE_PID" 2>/dev/null
    _VERIFY_FAKE_PID=""
  fi
  [ -n "$_VERIFY_TMP" ] && rm -rf "$_VERIFY_TMP"
  _VERIFY_TMP=""
}

# _verify_start_fake <root> <log>: a throwaway daemon on the fake transport; sets _VERIFY_FAKE_PID.
_verify_start_fake() {
  local root="$1" log="$2" bun i
  bun="$(daemon_bun_path)" || { _verify_fail "daemon: bun not found; run ./setup (or: curl -fsSL https://bun.sh/install | bash)"; return 1; }
  (
    cd "$LIAISON_REPO/bridge" || exit 1
    LIAISON_ROOT="$root" LIAISON_FAKE=1 LIAISON_OWNER_USER_IDS=U_VERIFY LIAISON_PUMP_MS=100 LIAISON_TICK_MS=500 \
      nohup "$bun" run src/index.ts </dev/null >"$log" 2>&1 &
    echo "$!" > "$root/fake.pid"
  ) || return 1
  _VERIFY_FAKE_PID="$(tr -d '[:space:]' < "$root/fake.pid" 2>/dev/null)"
  i=0
  while [ "$i" -lt 100 ]; do
    grep -q '"msg":"ready"' "$log" 2>/dev/null && return 0
    kill -0 "$_VERIFY_FAKE_PID" 2>/dev/null || break
    sleep 0.1; i=$((i + 1))
  done
  _verify_fail "daemon: the throwaway fake daemon did not start; see $log"
  return 1
}

# _verify_delivery <root> <slug> <id>: prints posted | pending | paused | missing | error:<reason>.
_verify_delivery() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys
root, slug, mid = sys.argv[1:4]
try:
    data = open(os.path.join(root, slug, "outbox.jsonl"), "rb").read()
except OSError:
    print("missing"); sys.exit(0)
end, pos = None, 0
for raw in data.splitlines(True):
    pos += len(raw)
    try:
        if json.loads(raw).get("id") == mid and raw.endswith(b"\n"):
            end = pos
            break
    except ValueError:
        pass
if end is None:
    print("missing"); sys.exit(0)
# Read state.json BEFORE the inbox: the daemon writes a give-up error line first and moves the cursor after, so a
# cursor that is already past the line means any error line for it is already readable.
try:
    st = json.load(open(os.path.join(root, "state.json")))
except (OSError, ValueError):
    st = {}
cur = st.get("cursors", {}).get(slug, 0)
if slug in (st.get("paused") or {}):
    # A paused channel drops the post but still moves the cursor: not a delivery.
    print("paused"); sys.exit(0)
try:
    for raw in open(os.path.join(root, slug, "inbox.jsonl"), "rb"):
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if d.get("kind") == "error" and d.get("ref_id") == mid:
            print("error:" + str(d.get("reason", "delivery failed"))); sys.exit(0)
except OSError:
    pass
print("posted" if cur >= end else "pending")
PY
}

verify_main() {
  local fake=0 root office utc out rc id slug inbox start now st
  while [ $# -gt 0 ]; do
    case "$1" in
      --fake) fake=1; shift ;;
      -h|--help) echo "usage: liaison verify [--fake]" >&2; return 0 ;;
      *) echo "liaison verify: unknown option '$1' (usage: liaison verify [--fake])" >&2; return 2 ;;
    esac
  done
  command -v python3 >/dev/null 2>&1 || { _verify_fail "python3 is required"; return 1; }
  trap '_verify_cleanup' EXIT

  office="$LIAISON_OFFICE"
  if [ "$fake" -eq 1 ]; then
    _VERIFY_TMP="$(mktemp -d "${TMPDIR:-/tmp}/liaison-verify.XXXXXX")" || { _verify_fail "could not create a temp folder"; return 1; }
    root="$_VERIFY_TMP"
    [ -d "$office" ] || { office="$root/office"; mkdir -p "$office"; }
    _verify_start_fake "$root" "$root/daemon.log" || { _verify_cleanup; return 1; }
    # The fake office is registered here, in the throwaway root; a real registry is never touched.
    out="$(LIAISON_ROOT="$root" "$(_bridge_cmd slack-register)" --office "$office" 2>&1)" \
      || { _verify_fail "office not registered: ${out:-slack-register failed}"; _verify_cleanup; return 1; }
  else
    root="$LIAISON_HOME"
    if ! daemon_live_pid >/dev/null && ! daemon_service_running >/dev/null; then
      _verify_fail "daemon not running (start it: liaison daemon start)"
      return 1
    fi
  fi
  say "verify: daemon ok"

  # 2 office
  if ! inbox="$(cd "$office" 2>/dev/null && LIAISON_ROOT="$root" "$(_bridge_cmd slack-inbox)" --path 2>&1)"; then
    _verify_fail "office not registered (${inbox:-slack-inbox --path failed}); run ./setup"
    _verify_cleanup; return 1
  fi
  slug="$(basename "$(dirname "$inbox")")"
  say "verify: office ok ($slug)"

  # 3 say
  utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  start="$(date +%s)"
  out="$(cd "$office" && LIAISON_ROOT="$root" "$(_bridge_cmd slack-say)" "liaison verify $utc" 2>&1)"; rc=$?
  id="$(printf '%s\n' "$out" | sed -n 's/.*(\(say_[A-Za-z0-9_]*\)).*/\1/p' | head -n 1)"
  if [ "$rc" -ne 0 ] || [ -z "$id" ]; then
    _verify_fail "say failed (exit $rc): $out"
    _verify_cleanup; return 1
  fi
  say "verify: say ok ($id)"

  # 4 delivery
  while :; do
    st="$(_verify_delivery "$root" "$slug" "$id")"
    # The fake daemon mirrors its posts to a file one cycle after sending them: wait for the text too.
    if [ "$st" = posted ] && [ "$fake" -eq 1 ] && ! grep -q "liaison verify $utc" "$root/_fake_posts.jsonl" 2>/dev/null; then
      st=pending
    fi
    case "$st" in
      posted) break ;;
      missing) _verify_fail "say queued nothing: no outbox line $id under $root/$slug"; _verify_cleanup; return 1 ;;
      paused) _verify_fail "delivery failed ($slug is paused; say \"resume\" in its Slack channel)"; _verify_cleanup; return 1 ;;
      error:*) _verify_fail "delivery failed: ${st#error:}"; _verify_cleanup; return 1 ;;
    esac
    now="$(date +%s)"
    if [ $((now - start)) -ge "$VERIFY_WAIT_S" ]; then
      _verify_fail "delivery: the daemon did not pick up $id within $VERIFY_WAIT_S s (see $root/daemon.log)"
      _verify_cleanup; return 1
    fi
    sleep 0.2
  done
  say "verify: delivery ok"
  now="$(date +%s)"
  _verify_cleanup
  say "verify: ok (round trip $((now - start)) s)"
}
