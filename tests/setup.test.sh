#!/bin/bash
# ./setup: tokens, env file, idempotency, office registration, greeting, PATH warning, aliases, autostart flag.
. "$(dirname "$0")/harness.sh"
ORIG_PATH="$PATH"
SETUP="$REPO_ROOT/setup"
LIAISON="$REPO_ROOT/bin/liaison"
BOT="xoxb-1111-leakcheck-AAA"
APP="xapp-2222-leakcheck-BBB"
OWNER="U01ABCDEF"

fresh() { # a new sandbox with a long-running fake bun (so the daemon step has a live process)
  if [ -n "${TMP:-}" ]; then
    "$LIAISON" daemon stop >/dev/null 2>&1
    rm -rf "$TMP"
  fi
  PATH="$ORIG_PATH"
  make_sandbox
  printf '#!/bin/bash\necho "$0 $*" >> "%s/calls.log"\nexec sleep 30\n' "$TMP" > "$TMP/fake-bin/bun"
  chmod +x "$TMP/fake-bin/bun"
  trap "'$LIAISON' daemon stop >/dev/null 2>&1; rm -rf '$TMP'" EXIT
  # slack-say stub: queues an outbox line and prints the real `queued -> <slug> (<id>)` line; with FAKE_SAY_DELIVER=1
  # (the default) it also moves the daemon cursor past that line, as a live daemon would.
  cat > "$TMP/fake-bin/slack-say" <<'SAY'
#!/bin/bash
echo "$0 $*" >> "$(dirname "$0")/../calls.log"
root="${LIAISON_ROOT:?}"; id="say_fake$$"
mkdir -p "$root/office"
printf '{"id":"%s"}\n' "$id" >> "$root/office/outbox.jsonl"
echo "queued -> office ($id)" >&2
if [ "${FAKE_SAY_DELIVER:-1}" = 1 ]; then
  printf '{"cursors":{"office":%s}}' "$(wc -c < "$root/office/outbox.jsonl" | tr -d ' ')" > "$root/state.json"
fi
exit 0
SAY
  chmod +x "$TMP/fake-bin/slack-say"
  export LIAISON_VERIFY_WAIT_S=1   # no daemon in the sandbox: a pending greeting gives up after 1 s
  export SHELL=/bin/bash
  export LIAISON_BRIDGE_BIN="$TMP/fake-bin"
  export LIAISON_OFFICE="$TMP/office"; mkdir -p "$LIAISON_OFFICE"  # the engine step writes .claude/ into the office
}

run_setup() { # run_setup [args...]: tokens from env, no tty
  LIAISON_BOT_TOKEN="${T_BOT-$BOT}" LIAISON_APP_TOKEN="${T_APP-$APP}" LIAISON_OWNER_USER_IDS="${T_OWNER-$OWNER}" \
    "$SETUP" --yes --no-autostart "$@" </dev/null 2>&1
}

# --- setup_writes_env_600 -------------------------------------------------
fresh
out="$(run_setup)"; rc=$?
assert_eq 0 "$rc" "setup_writes_env_600: exit 0"
ENVF="$LIAISON_HOME/.env"
assert_file_mode "$ENVF" 600 "setup_writes_env_600: mode"
env_text="$(cat "$ENVF" 2>/dev/null)"
assert_contains "$env_text" "LIAISON_BOT_TOKEN=$BOT" "env has bot token"
assert_contains "$env_text" "LIAISON_APP_TOKEN=$APP" "env has app token"
assert_contains "$env_text" "LIAISON_OWNER_USER_IDS=$OWNER" "env has owner ids"
case "$out" in *"$BOT"*|*"$APP"*) assert_eq "no token in stdout" "token leaked" "setup_writes_env_600: no token echoed" ;; *) assert_eq 1 1 ;; esac
assert_eq '["U01ABCDEF"]' "$(. "$REPO_ROOT/lib/state.sh"; config_get owner_user_ids)" "owner ids stored in config"
for leak in "$TMP/calls.log" "$LIAISON_STATE_DIR"; do
  grep -rqF -e "$BOT" -e "$APP" "$leak" 2>/dev/null; assert_eq 1 $? "no token value in $(basename "$leak")"
done

# --- setup_rejects_bad_tokens ---------------------------------------------
fresh
T_BOT=abc run_setup >/dev/null; rc=$?
assert_eq 2 "$rc" "setup_rejects_bad_tokens: exit 2"
[ -e "$LIAISON_HOME/.env" ] && assert_eq "absent" "present" "setup_rejects_bad_tokens: no .env" || assert_eq 1 1
T_APP=xoxb-wrongkind run_setup >/dev/null; rc=$?
assert_eq 2 "$rc" "app token must start with xapp-"
T_OWNER=bob run_setup >/dev/null; rc=$?
assert_eq 2 "$rc" "owner id must look like a member id"
[ -e "$LIAISON_HOME/.env" ] && assert_eq "absent" "present" "still no .env" || assert_eq 1 1

# --- setup_trims_token_whitespace -----------------------------------------
fresh
T_BOT="$(printf 'xoxb-fake1 \n')" T_APP="$(printf '  xapp-fake2\n')" run_setup >/dev/null; rc=$?
assert_eq 0 "$rc" "setup_trims_token_whitespace: exit 0"
env_text="$(cat "$LIAISON_HOME/.env")"
assert_contains "$env_text" "LIAISON_BOT_TOKEN=xoxb-fake1
" "bot token trimmed"
assert_contains "$env_text" "LIAISON_APP_TOKEN=xapp-fake2
" "app token trimmed"

# --- LIAISON_ENV_FILE and multiple owner ids -------------------------------
fresh
printf 'LIAISON_BOT_TOKEN="%s"\nLIAISON_APP_TOKEN=%s\nLIAISON_OWNER_USER_IDS=U01ABCDEF, W02GHIJKL\n' "$BOT" "$APP" > "$TMP/in.env"
out="$(T_BOT= T_APP= T_OWNER= LIAISON_ENV_FILE="$TMP/in.env" "$SETUP" --yes --no-autostart </dev/null 2>&1)"; rc=$?
assert_eq 0 "$rc" "env file: exit 0"
assert_contains "$(cat "$LIAISON_HOME/.env")" "LIAISON_OWNER_USER_IDS=U01ABCDEF,W02GHIJKL" "env file: owners normalised"
case "$out" in *"$BOT"*) assert_eq "no token" "leaked" "env file: no token echoed" ;; *) assert_eq 1 1 ;; esac

# --- tokens are required with --yes ----------------------------------------
fresh
out="$(env -u LIAISON_BOT_TOKEN -u LIAISON_APP_TOKEN -u LIAISON_OWNER_USER_IDS "$SETUP" --yes --no-autostart </dev/null 2>&1)"; rc=$?
assert_eq 2 "$rc" "missing tokens with --yes exits 2"
assert_contains "$out" "LIAISON_BOT_TOKEN" "missing tokens message names the variable"

# --- setup_rerun_is_noop --------------------------------------------------
fresh
run_setup >/dev/null
touch -t 202001010000 "$LIAISON_HOME/.env"
before="$(ls -l "$LIAISON_HOME/.env")"
out="$(run_setup)"; rc=$?
assert_eq 0 "$rc" "setup_rerun_is_noop: exit 0"
assert_contains "$out" "nothing to do" "setup_rerun_is_noop: message"
assert_eq "$before" "$(ls -l "$LIAISON_HOME/.env")" "setup_rerun_is_noop: .env untouched"
assert_eq 1 "$(grep -c 'slack-say' "$TMP/calls.log")" "rerun does not greet twice"

# --- setup_registers_office_and_greets --------------------------------------
fresh
run_setup >/dev/null
calls="$(cat "$TMP/calls.log")"
assert_contains "$calls" "slack-register --office $LIAISON_OFFICE" "register office"
reg_line="$(grep -n 'slack-register' "$TMP/calls.log" | head -n 1 | cut -d: -f1)"
say_line="$(grep -n 'slack-say' "$TMP/calls.log" | head -n 1 | cut -d: -f1)"
[ -n "$reg_line" ] && [ -n "$say_line" ] && [ "$reg_line" -lt "$say_line" ]; assert_eq 0 $? "register comes before greeting"
assert_contains "$calls" "What should I work on first?" "greeting text sent"
assert_contains "$calls" "#liaison-office" "greeting names the channel"
case "$calls" in *"{owner_name}"*|*"{office_channel}"*) assert_eq "substituted" "placeholder left" "greeting placeholders" ;; *) assert_eq 1 1 ;; esac
assert_eq ok "$(. "$REPO_ROOT/lib/state.sh"; state_get greeting)" "greeting step marked ok"
assert_eq ok "$(. "$REPO_ROOT/lib/state.sh"; state_get office_channel)" "office_channel step marked ok"

# --- steps recorded; engine skipped until Task 7 ----------------------------
. "$REPO_ROOT/lib/state.sh"
for s in bun tokens daemon office_channel greeting path language; do assert_eq ok "$(state_get $s)" "state $s ok"; done
if [ -e "$REPO_ROOT/engines/claude/install.sh" ]; then assert_eq ok "$(state_get engine)" "engine installed"
else assert_eq skipped "$(state_get engine)" "engine skipped while the layer is absent"; fi

# --- symlinks into ~/.local/bin; setup_warns_when_local_bin_not_on_path ------
fresh
out="$(run_setup)"
[ -L "$HOME/.local/bin/liaison" ]; assert_eq 0 $? "liaison symlinked"
[ -L "$HOME/.local/bin/slack-say" ]; assert_eq 0 $? "slack-say symlinked"
assert_contains "$out" ".local/bin is not on your PATH" "setup_warns_when_local_bin_not_on_path"
fresh
out="$(PATH="$HOME/.local/bin:$PATH" run_setup)"
case "$out" in *"not on your PATH"*) assert_eq "no warning" "warned" "no PATH warning when present" ;; *) assert_eq 1 1 ;; esac

# --- step_path never repoints other tools' links -----------------------------------
fresh
mkdir -p "$HOME/.local/bin" "$TMP/other"
: > "$TMP/other/slack-say"
ln -s "$TMP/other/slack-say" "$HOME/.local/bin/slack-say"          # foreign symlink
ln -s "$REPO_ROOT/bin/gone" "$HOME/.local/bin/liaison"              # our own, stale target
printf 'mine\n' > "$HOME/.local/bin/slack-ack"                       # regular file
out="$(run_setup)"; rc=$?
assert_eq 0 "$rc" "path step with foreign links: exit 0"
assert_eq "$TMP/other/slack-say" "$(readlink "$HOME/.local/bin/slack-say")" "foreign symlink left untouched"
assert_contains "$out" "~/.local/bin/slack-say already exists and points elsewhere; left untouched" "foreign symlink warned"
assert_eq "$REPO_ROOT/bin/liaison" "$(readlink "$HOME/.local/bin/liaison")" "own symlink refreshed"
assert_eq "mine" "$(cat "$HOME/.local/bin/slack-ack")" "regular file left untouched"
[ -L "$HOME/.local/bin/slack-ack" ]; assert_eq 1 $? "regular file not replaced by a link"
assert_contains "$out" "~/.local/bin/slack-ack already exists and is not a symlink; left untouched" "regular file warned"
assert_eq "$REPO_ROOT/bridge/bin/slack-ask" "$(readlink "$HOME/.local/bin/slack-ask")" "free names still linked"

# --- autostart: success and failure branches (service managers are stubs) ---------------
run_auto() { # run_auto [args...]: like run_setup but with autostart on
  LIAISON_BOT_TOKEN="$BOT" LIAISON_APP_TOKEN="$APP" LIAISON_OWNER_USER_IDS="$OWNER" \
    "$SETUP" --yes --no-aliases "$@" </dev/null 2>&1
}
PLIST_REL="Library/LaunchAgents/liaison-bridge.plist"
UNIT_REL=".config/systemd/user/liaison-bridge.service"

fresh
out="$(LIAISON_UNAME=Darwin run_auto)"; rc=$?
assert_eq 0 "$rc" "macOS autostart success: exit 0"
[ -f "$HOME/$PLIST_REL" ]; assert_eq 0 $? "macOS autostart success: plist rendered"
assert_contains "$(cat "$TMP/calls.log")" "launchctl bootstrap gui/$(id -u) $HOME/$PLIST_REL" "launchctl bootstrap called"
assert_contains "$(. "$REPO_ROOT/lib/state.sh"; state_detail daemon)" "launchd" "daemon state records launchd"
assert_eq "" "$(grep 'bun run' "$TMP/calls.log")" "no manual daemon next to the service"

fresh
out="$(LIAISON_UNAME=Darwin FAKE_LAUNCHCTL_EXIT=1 run_auto)"; rc=$?
assert_eq 0 "$rc" "macOS autostart failure: setup still succeeds"
[ -e "$HOME/$PLIST_REL" ]; assert_eq 1 $? "macOS autostart failure: plist removed"
assert_contains "$out" "starting the daemon by hand instead" "failure message"
assert_contains "$(LIAISON_UNAME=Darwin "$LIAISON" daemon status)" "running" "manual daemon started after the fallback"
assert_contains "$(. "$REPO_ROOT/lib/state.sh"; state_detail daemon)" "manual" "daemon state records manual"

fresh
out="$(LIAISON_UNAME=Linux run_auto)"; rc=$?
assert_eq 0 "$rc" "systemd autostart success: exit 0"
[ -f "$HOME/$UNIT_REL" ]; assert_eq 0 $? "systemd autostart success: unit rendered"
assert_contains "$(cat "$TMP/calls.log")" "systemctl --user enable --now liaison-bridge.service" "systemctl enable called"
[ -e "$HOME/$PLIST_REL" ]; assert_eq 1 $? "no plist on the Linux branch"

fresh
out="$(LIAISON_UNAME=Linux FAKE_SYSTEMCTL_EXIT=1 run_auto)"; rc=$?
assert_eq 0 "$rc" "systemd autostart failure: setup still succeeds"
[ -e "$HOME/$UNIT_REL" ]; assert_eq 1 $? "systemd autostart failure: unit removed"
assert_contains "$out" "starting the daemon by hand instead" "systemd failure message"
LIAISON_UNAME=Linux "$LIAISON" daemon status | grep -q running; assert_eq 0 $? "manual daemon started after the systemd fallback"

# --- setup_aliases_once ------------------------------------------------------
fresh
run_setup >/dev/null
rm -f "$LIAISON_STATE_DIR/state.json"          # force every step to run again
run_setup >/dev/null
assert_eq 1 "$(grep -c '^# liaison start$' "$HOME/.bashrc")" "setup_aliases_once: one start marker"
assert_eq 1 "$(grep -c '^# liaison end$' "$HOME/.bashrc")" "setup_aliases_once: one end marker"
rc_text="$(cat "$HOME/.bashrc")"
assert_contains "$rc_text" "alias claude3='CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 claude'" "claude3 alias"
assert_contains "$rc_text" "alias claude5='CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 claude'" "claude5 alias"
case "$rc_text" in *liaison-coordinator*) assert_eq "absent" "present" "supervised mode: no coordinator alias" ;; *) assert_eq 1 1 ;; esac
# switching to unattended rewrites the same block; text outside the block survives
printf 'export KEEP=1\n' >> "$HOME/.bashrc"
run_setup --permission-mode unattended >/dev/null
rc_text="$(cat "$HOME/.bashrc")"
assert_eq 1 "$(grep -c '^# liaison start$' "$HOME/.bashrc")" "still one block after mode change"
assert_contains "$rc_text" "alias liaison-coordinator='CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 claude --dangerously-skip-permissions'" "unattended adds the coordinator alias"
assert_contains "$rc_text" "export KEEP=1" "text outside the block kept"
assert_eq unattended "$(config_get permission_mode)" "permission_mode stored"
run_setup --permission-mode supervised >/dev/null
case "$(cat "$HOME/.bashrc")" in *liaison-coordinator*) assert_eq "removed" "still there" "back to supervised drops the alias" ;; *) assert_eq 1 1 ;; esac
run_setup --permission-mode nonsense >/dev/null; rc=$?
assert_eq 2 "$rc" "bad --permission-mode exits 2"

# zsh users get ~/.zshrc; --no-aliases writes nothing
fresh
SHELL=/bin/zsh run_setup >/dev/null
[ -f "$HOME/.zshrc" ] && grep -q '^# liaison start$' "$HOME/.zshrc"; assert_eq 0 $? "zsh: ~/.zshrc gets the block"
fresh
run_setup --no-aliases >/dev/null
[ -e "$HOME/.bashrc" ] || [ -e "$HOME/.zshrc" ]; assert_eq 1 $? "--no-aliases writes no rc file"

# --- setup_no_autostart_flag ---------------------------------------------------
fresh
run_setup >/dev/null
[ -e "$HOME/Library/LaunchAgents/liaison-bridge.plist" ] || [ -e "$HOME/.config/systemd/user/liaison-bridge.service" ]
assert_eq 1 $? "setup_no_autostart_flag: no service file written"
assert_contains "$("$LIAISON" daemon status)" "running" "manual daemon is running after setup"

# --- service templates render --------------------------------------------------
. "$REPO_ROOT/lib/common.sh"
. "$REPO_ROOT/lib/daemon.sh"
. "$REPO_ROOT/lib/setup-steps.sh"
render_service_template "$REPO_ROOT/bridge/service/liaison-bridge.plist.tmpl" "$TMP/out.plist" "/opt/b&b/bun" "/r/bridge" "/h/me" "/h/me/.liaison" "/opt/b&b:/usr/bin"
plist="$(cat "$TMP/out.plist")"
assert_contains "$plist" "/opt/b&amp;b/bun" "plist: an ampersand in a path is XML-escaped"
assert_contains "$plist" "/r/bridge/src/index.ts" "plist: entry point"
assert_contains "$plist" "/h/me/.liaison" "plist: LIAISON_ROOT"
case "$plist" in *"{BUN}"*|*"{BRIDGE_DIR}"*|*"{HOME}"*|*"{LIAISON_HOME}"*|*"{PATH}"*) assert_eq "rendered" "placeholder left" "plist placeholders" ;; *) assert_eq 1 1 ;; esac
render_service_template "$REPO_ROOT/bridge/service/liaison-bridge.service.tmpl" "$TMP/out.service" "/usr/bin/bun" "/r/bridge" "/h/me" "/h/me/.liaison" "/usr/bin"
unit="$(cat "$TMP/out.service")"
assert_contains "$unit" "ExecStart=/usr/bin/bun run /r/bridge/src/index.ts" "unit: ExecStart"
assert_contains "$unit" "Environment=PATH=/usr/bin" "unit: PATH set explicitly"
assert_contains "$unit" "WantedBy=default.target" "unit: install section"
if command -v plutil >/dev/null 2>&1; then plutil -lint "$TMP/out.plist" >/dev/null 2>&1; assert_eq 0 $? "plist is valid"; fi

# --- missing prerequisite -------------------------------------------------------
fresh
mkdir -p "$TMP/nobun"
for t in git python3 claude jq; do ln -s "$(command -v $t)" "$TMP/nobun/$t"; done
out="$(PATH="$TMP/nobun:/usr/bin:/bin" LIAISON_BOT_TOKEN=$BOT LIAISON_APP_TOKEN=$APP LIAISON_OWNER_USER_IDS=$OWNER "$SETUP" --yes --no-autostart </dev/null 2>&1)"; rc=$?
if [ ! -x /usr/bin/bun ] && [ ! -x /bin/bun ]; then
  assert_eq 1 "$rc" "missing bun without --install-bun fails"
  assert_contains "$out" "bun" "message names bun"
  assert_contains "$out" "curl -fsSL https://bun.sh/install | bash" "message says how to install bun"
fi

# jq is required (slack-wait uses it): a PATH without it stops setup with the install hint.
fresh
mkdir -p "$TMP/nojq"
for t in git python3 claude dirname; do ln -s "$(command -v $t)" "$TMP/nojq/$t"; done
out="$(PATH="$TMP/nojq" LIAISON_BOT_TOKEN=$BOT LIAISON_APP_TOKEN=$APP LIAISON_OWNER_USER_IDS=$OWNER /bin/bash "$SETUP" --yes --no-autostart </dev/null 2>&1)"; rc=$?
assert_eq 1 "$rc" "missing jq fails"
assert_contains "$out" "jq is missing" "message names jq"
assert_contains "$out" "apt install jq" "message says how to install jq"

# --- I1: bun in ~/.bun/bin but not on PATH is still found by later steps -----------------------------------
fresh
rm -f "$TMP/fake-bin/bun"
mkdir -p "$HOME/.bun/bin" "$TMP/nobun"
printf '#!/bin/bash\necho "$0 $*" >> "%s/calls.log"\nexec sleep 30\n' "$TMP" > "$HOME/.bun/bin/bun"
chmod +x "$HOME/.bun/bin/bun"
for t in git python3 jq; do ln -s "$(command -v $t)" "$TMP/nobun/$t"; done
for t in claude slack-say tmux; do ln -s "$TMP/fake-bin/$t" "$TMP/nobun/$t"; done
# a slack-register that, like the real one (`#!/usr/bin/env bun`), needs bun on PATH
printf '#!/bin/bash\ncommand -v bun >/dev/null 2>&1 || { echo "env: bun: No such file or directory" >&2; exit 127; }\necho "$0 $*" >> "%s/calls.log"\nexit 0\n' "$TMP" > "$TMP/nobun/slack-register"
chmod +x "$TMP/nobun/slack-register"
out="$(PATH="$TMP/nobun:/usr/bin:/bin" LIAISON_BRIDGE_BIN="$TMP/nobun" LIAISON_BOT_TOKEN=$BOT LIAISON_APP_TOKEN=$APP LIAISON_OWNER_USER_IDS=$OWNER "$SETUP" --yes --no-autostart </dev/null 2>&1)"; rc=$?
assert_eq 0 "$rc" "I1 bun only in ~/.bun/bin: setup exits 0"
case "$out" in *"No such file"*) assert_eq "no error" "$out" "I1: slack-register found bun" ;; *) assert_eq 1 1 ;; esac
assert_contains "$(cat "$TMP/calls.log")" "slack-register --office $LIAISON_OFFICE" "I1: the office step called slack-register"
PATH="$ORIG_PATH"

# --- I3: a declined path/aliases prompt stays declined under --yes -------------------------------------------
fresh
out="$(LIAISON_BOT_TOKEN=$BOT LIAISON_APP_TOKEN=$APP LIAISON_OWNER_USER_IDS=$OWNER "$SETUP" --no-autostart <<'ANS' 2>&1
en
supervised

liaison-office
n
n
ANS
)"; rc=$?
assert_eq 0 "$rc" "I3 first run (decline path and aliases): exit 0"
assert_eq skipped "$(state_get path)" "I3: path recorded as skipped"
assert_eq skipped "$(state_get aliases)" "I3: aliases recorded as skipped"
[ -e "$HOME/.local/bin/liaison" ]; assert_eq 1 $? "I3: no symlink after the decline"
out="$(run_setup)"; rc=$?
assert_eq 0 "$rc" "I3 re-run with --yes: exit 0"
[ -e "$HOME/.local/bin/liaison" ]; assert_eq 1 $? "I3: --yes does not link after a decline"
[ -e "$HOME/.bashrc" ] && grep -q '^# liaison start$' "$HOME/.bashrc"; assert_eq 1 $? "I3: --yes does not add the alias block after a decline"
assert_contains "$out" "nothing to do" "I3: re-run says nothing to do"

# --- I4: a greeting that is only queued is not marked ok ---------------------------------------------------------
fresh
out="$(FAKE_SAY_DELIVER=0 run_setup)"; rc=$?
assert_eq 0 "$rc" "I4 queued only: setup still exits 0"
assert_eq missing "$(state_get greeting)" "I4: greeting stays missing"
assert_contains "$(state_detail greeting)" "queued office say_fake" "I4: detail records the queued id"
assert_contains "$out" "greeting: queued, not delivered yet" "I4: says it is not delivered"
assert_contains "$out" "liaison verify" "I4: points at liaison verify"
assert_eq "next: liaison verify" "$(printf '%s\n' "$out" | tail -n 1)" "I4: setup ends with next: liaison verify"
assert_contains "$("$LIAISON" status)" "greeting: missing" "I4: status shows the greeting as missing"
# a re-run does not greet twice; once the daemon catches up the step turns ok
out="$(FAKE_SAY_DELIVER=0 run_setup)"
assert_eq 1 "$(grep -c 'slack-say' "$TMP/calls.log")" "I4: a re-run does not queue a second greeting"
printf '{"cursors":{"office":%s}}' "$(wc -c < "$LIAISON_HOME/office/outbox.jsonl" | tr -d ' ')" > "$LIAISON_HOME/state.json"
out="$(run_setup)"
assert_contains "$out" "greeting: delivered" "I4: delivered once the cursor passed the line"
assert_eq ok "$(state_get greeting)" "I4: greeting turns ok"
# a delivered greeting prints the delivered line on the first run
fresh
out="$(run_setup)"
assert_contains "$out" "greeting: delivered" "I4: delivered greeting is reported"

# --- M1: the greeting uses the name asked in step_language ------------------------------------------------------
fresh
out="$(LIAISON_OWNER_NAME=Sam run_setup)"
assert_contains "$(cat "$TMP/calls.log")" "Hi Sam," "M1: LIAISON_OWNER_NAME reaches the greeting"
assert_eq Sam "$(config_get owner_name)" "M1: owner_name stored"
fresh
out="$(run_setup)"
assert_contains "$(cat "$TMP/calls.log")" "Hi there," "M1: --yes without a name greets 'there'"
fresh
out="$(LIAISON_BOT_TOKEN=$BOT LIAISON_APP_TOKEN=$APP LIAISON_OWNER_USER_IDS=$OWNER "$SETUP" --no-autostart --no-aliases <<'ANS' 2>&1
en
supervised
Robin

n
ANS
)"
assert_contains "$out" "Your name (for the greeting) [there]:" "M1: the prompt shows the default"
assert_contains "$(cat "$TMP/calls.log")" "Hi Robin," "M1: the typed name is used"

# --- M5: the rc rewrite keeps its mode and a failed rewrite leaves the file alone ------------------------------------
fresh
run_setup >/dev/null
chmod 640 "$HOME/.bashrc"
run_setup --permission-mode unattended >/dev/null
assert_file_mode "$HOME/.bashrc" 640 "M5: rc mode kept across a rewrite"
assert_eq 0 "$(ls "$HOME" | grep -c 'liaison')" "M5: no temp file left next to the rc"

# --- usage ------------------------------------------------------------------------
fresh
out="$("$SETUP" --bogus 2>&1)"; rc=$?
assert_eq 2 "$rc" "unknown flag exits 2"
assert_contains "$out" "usage" "unknown flag prints usage"
out="$("$LIAISON" setup --bogus 2>&1)"; rc=$?
assert_eq 2 "$rc" "liaison setup forwards to ./setup"

report
