#!/bin/bash
# One function per ./setup step. Sourced by ./setup (and by tests). bash 3.2 compatible.
# Every step is guarded by state_get (or, for aliases, by comparing the rc block), so a re-run does only what is
# missing. A step that changed something sets WORK=1; WORK=0 at the end means "nothing to do".
# Secrets (tokens) are never printed, never passed as arguments, and only ever written to $LIAISON_HOME/.env.

WORK="${WORK:-0}"
OPT_YES="${OPT_YES:-0}"

bad_input() { echo "liaison: $*" >&2; exit 2; }

trim() { # trim <string>: strips leading and trailing whitespace, newlines included
  local t="$1"
  t="${t#"${t%%[![:space:]]*}"}"
  t="${t%"${t##*[![:space:]]}"}"
  printf '%s' "$t"
}

# ask <prompt> <default>: the default under --yes or when stdin is closed.
ask() {
  local ans=""
  if [ "$OPT_YES" = 1 ]; then printf '%s\n' "$2"; return 0; fi
  printf '%s [%s]: ' "$1" "$2" >&2
  IFS= read -r ans || ans=""
  ans="$(trim "$ans")"
  printf '%s\n' "${ans:-$2}"
}

# confirm <prompt> <y|n>: succeeds on yes.
confirm() {
  local ans=""
  if [ "$OPT_YES" = 1 ]; then [ "$2" = y ]; return; fi
  if [ "$2" = y ]; then printf '%s [Y/n]: ' "$1" >&2; else printf '%s [y/N]: ' "$1" >&2; fi
  IFS= read -r ans || ans=""
  ans="$(trim "$ans")"
  case "${ans:-$2}" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# bridge_cmd <name>: the bridge verb to run. LIAISON_BRIDGE_BIN overrides the directory (tests use stubs).
bridge_cmd() { printf '%s/%s\n' "${LIAISON_BRIDGE_BIN:-$LIAISON_REPO/bridge/bin}" "$1"; }

# --- 1. prerequisites ------------------------------------------------------------------------------------

step_prereqs() {
  local bun p
  command -v python3 >/dev/null 2>&1 || {
    echo "liaison: python3 is missing and is required. Install it (macOS: 'xcode-select --install' or 'brew install python'; Debian/Ubuntu: 'sudo apt install python3') and re-run ./setup." >&2
    exit 1
  }
  command -v jq >/dev/null 2>&1 || {
    echo "liaison: jq is missing and is required (slack-wait uses it). Install it (macOS: 'brew install jq'; Debian/Ubuntu: 'sudo apt install jq') and re-run ./setup." >&2
    exit 1
  }
  command -v git >/dev/null 2>&1 || {
    echo "liaison: git is missing and is required. Install it from https://git-scm.com/downloads and re-run ./setup." >&2
    exit 1
  }
  command -v claude >/dev/null 2>&1 || {
    echo "liaison: the claude command is missing and is required. Install Claude Code (https://docs.claude.com/en/docs/claude-code/overview) and re-run ./setup." >&2
    exit 1
  }
  # bun may live in ~/.bun/bin without being on PATH (a fresh bun install only edits the shell rc): put its folder on PATH
  # for the rest of this run, because later steps run bridge scripts that start with `#!/usr/bin/env bun`.
  if bun="$(daemon_bun_path)"; then export PATH="$(dirname "$bun"):$PATH"; fi
  [ "$(state_get bun)" = ok ] && return 0
  if ! bun="$(daemon_bun_path)"; then
    if [ "$OPT_YES" = 1 ] && [ "${OPT_INSTALL_BUN:-0}" != 1 ]; then
      echo "liaison: bun is missing and is required. Install it with: curl -fsSL https://bun.sh/install | bash (or re-run ./setup --yes --install-bun)." >&2
      exit 1
    fi
    if [ "$OPT_YES" != 1 ] && [ "${OPT_INSTALL_BUN:-0}" != 1 ] && ! confirm "bun is missing. Install it now (curl -fsSL https://bun.sh/install | bash)?" y; then
      echo "liaison: bun is required. Install it with: curl -fsSL https://bun.sh/install | bash, then re-run ./setup." >&2
      exit 1
    fi
    p="$(mktemp "${TMPDIR:-/tmp}/liaison-bun.XXXXXX")" || exit 1
    if ! curl -fsSL https://bun.sh/install -o "$p" || ! /bin/bash "$p" >&2; then
      rm -f "$p"
      echo "liaison: installing bun failed. Install it yourself (https://bun.sh) and re-run ./setup." >&2
      exit 1
    fi
    rm -f "$p"
    bun="$(daemon_bun_path)" || { echo "liaison: bun was installed but not found; open a new shell and re-run ./setup." >&2; exit 1; }
    export PATH="$(dirname "$bun"):$PATH"
  fi
  state_set bun ok "$bun"
  if command -v gh >/dev/null 2>&1; then say "gh: found (optional)"; else say "gh: not found (optional; the release flow uses it)"; fi
  WORK=1
}

# --- 2. language and permission mode ---------------------------------------------------------------------

step_language() {
  local lang mode cur_lang cur_mode name="" first=0
  cur_lang="$(config_get language)"; cur_mode="$(config_get permission_mode)"
  [ "$(state_get language)" = ok ] || first=1
  lang="$cur_lang"; mode="$cur_mode"
  if [ -n "${OPT_LANG:-}" ]; then lang="$OPT_LANG"
  elif [ "$first" = 1 ]; then lang="$(ask "Language for replies (two-letter code)" "$cur_lang")"; fi
  if [ -n "${OPT_PERM:-}" ]; then mode="$OPT_PERM"
  elif [ "$first" = 1 ]; then mode="$(ask "Permission mode: supervised (asks before risky actions) or unattended (never asks)" "$cur_mode")"; fi
  if [ "$first" = 1 ]; then
    name="$(ask "Your name (for the greeting)" "${LIAISON_OWNER_NAME:-there}")"
    case "$name" in ''|\[*|\{*) name="there" ;; esac
  fi
  case "$lang" in
    [a-z][a-z]|[a-z][a-z]-[A-Za-z][A-Za-z]) ;;
    *) bad_input "language must look like 'en' or 'pt-BR', got '$lang'" ;;
  esac
  case "$mode" in supervised|unattended) ;; *) bad_input "permission mode must be 'supervised' or 'unattended', got '$mode'" ;; esac
  [ "$first" = 0 ] && [ "$lang" = "$cur_lang" ] && [ "$mode" = "$cur_mode" ] && return 0
  config_set language "$lang" || exit 1
  config_set permission_mode "$mode" || exit 1
  [ -z "$name" ] || config_set owner_name "$name" || exit 1
  state_set language ok "language $lang, permission_mode $mode"
  if [ "$mode" = unattended ]; then
    say "note: unattended mode means the coordinator alias skips Claude Code permission prompts."
  fi
  WORK=1
}

# --- 3. Slack tokens -------------------------------------------------------------------------------------

valid_bot()   { case "$1" in xoxb-?*) case "$1" in *[[:space:]]*) return 1 ;; esac; return 0 ;; *) return 1 ;; esac; }
valid_app()   { case "$1" in xapp-?*) case "$1" in *[[:space:]]*) return 1 ;; esac; return 0 ;; *) return 1 ;; esac; }
valid_owner() { # a comma-separated list of Slack member ids
  local id list="$1" n=0
  [ -n "$list" ] || return 1
  for id in $(printf '%s' "$list" | tr ',' ' '); do
    printf '%s' "$id" | grep -Eq '^[UW][A-Z0-9]{6,}$' || return 1
    n=$((n + 1))
  done
  [ "$n" -gt 0 ]
}

normalise_owners() { # "U1, W2" -> "U1,W2"
  local id out="" list="$1"
  for id in $(printf '%s' "$list" | tr ',' ' '); do out="${out:+$out,}$id"; done
  printf '%s' "$out"
}

# read_env_file <file>: fills LIAISON_{BOT_TOKEN,APP_TOKEN,OWNER_USER_IDS} that are still empty. Prints nothing.
read_env_file() {
  local line key val
  [ -f "$1" ] || bad_input "LIAISON_ENV_FILE '$1' is not a file"
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="$(trim "${line%%=*}")"; val="$(trim "${line#*=}")"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    case "$key" in
      LIAISON_BOT_TOKEN)      [ -n "${LIAISON_BOT_TOKEN:-}" ]      || LIAISON_BOT_TOKEN="$val" ;;
      LIAISON_APP_TOKEN)      [ -n "${LIAISON_APP_TOKEN:-}" ]      || LIAISON_APP_TOKEN="$val" ;;
      LIAISON_OWNER_USER_IDS) [ -n "${LIAISON_OWNER_USER_IDS:-}" ] || LIAISON_OWNER_USER_IDS="$val" ;;
    esac
  done < "$1"
}

# collect <env-var> <validator> <secret 0|1> <label> <rule>: prints the validated value. Env wins; else prompt.
collect() {
  local var="$1" check="$2" secret="$3" label="$4" rule="$5" val tries=0
  val="$(trim "${!var:-}")"
  if [ -n "$val" ]; then
    "$check" "$val" || bad_input "$var is not valid: $rule"
    printf '%s' "$val"; return 0
  fi
  [ "$OPT_YES" = 1 ] && bad_input "$var is required (set it in the environment, or LIAISON_ENV_FILE=<file>)"
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    printf '%s: ' "$label" >&2
    if [ "$secret" = 1 ]; then IFS= read -rs val || val=""; printf '\n' >&2; else IFS= read -r val || val=""; fi
    val="$(trim "$val")"
    if [ -z "$val" ]; then bad_input "$var is required"; fi
    if "$check" "$val"; then printf '%s' "$val"; return 0; fi
    echo "That does not look right: $rule" >&2
  done
  bad_input "$var is not valid: $rule"
}

write_env_file() { # write_env_file <bot> <app> <owners>: mode 600, other keys in an existing file kept
  local f="$LIAISON_HOME/.env" tmp rc
  ( umask 077; mkdir -p "$LIAISON_HOME" ) || return 1
  tmp="$(umask 077; mktemp "$LIAISON_HOME/.env.XXXXXX")" || return 1
  if [ -f "$f" ]; then
    grep -v -E '^(export[[:space:]]+)?LIAISON_(BOT_TOKEN|APP_TOKEN|OWNER_USER_IDS)=' "$f" > "$tmp"
    rc=$?
    [ "$rc" -le 1 ] || { rm -f "$tmp"; return 1; }
  fi
  printf 'LIAISON_BOT_TOKEN=%s\nLIAISON_APP_TOKEN=%s\nLIAISON_OWNER_USER_IDS=%s\n' "$1" "$2" "$3" >> "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" && mv "$tmp" "$f"
}

step_tokens() {
  local bot app owners ids_json id n=0
  [ "$(state_get tokens)" = ok ] && return 0
  [ -n "${LIAISON_ENV_FILE:-}" ] && read_env_file "$LIAISON_ENV_FILE"
  if [ "$OPT_YES" != 1 ] && { [ -z "${LIAISON_BOT_TOKEN:-}" ] || [ -z "${LIAISON_APP_TOKEN:-}" ]; }; then
    cat >&2 <<EOM

Slack app: create it once from the manifest, then paste two tokens (input is hidden).
  1. Open https://api.slack.com/apps -> Create New App -> From a manifest, and paste:
       $LIAISON_REPO/bridge/slack-manifest.yml
  2. Install the app to your workspace; copy the Bot User OAuth Token (starts with xoxb-).
  3. Basic Information -> App-Level Tokens -> Generate (scope connections:write); copy it (starts with xapp-).
  4. In Slack: your profile -> the three dots -> Copy member ID (starts with U or W).
EOM
  fi
  bot="$(collect LIAISON_BOT_TOKEN valid_bot 1 "Bot User OAuth Token (xoxb-...)" "it must start with xoxb-")" || exit $?
  app="$(collect LIAISON_APP_TOKEN valid_app 1 "App-Level Token (xapp-...)" "it must start with xapp-")" || exit $?
  owners="$(collect LIAISON_OWNER_USER_IDS valid_owner 0 "Your Slack member ID" "member ids look like U01ABCDEF, comma-separated")" || exit $?
  owners="$(normalise_owners "$owners")"
  write_env_file "$bot" "$app" "$owners" || die "could not write $LIAISON_HOME/.env"
  ids_json=""
  for id in $(printf '%s' "$owners" | tr ',' ' '); do ids_json="${ids_json:+$ids_json,}\"$id\""; n=$((n + 1)); done
  config_set owner_user_ids "[$ids_json]" || exit 1
  state_set tokens ok "$n owner id(s); file mode 600"
  say "tokens: saved to $LIAISON_HOME/.env"
  WORK=1
}

# --- 4. daemon and autostart -----------------------------------------------------------------------------

# render_service_template <template> <out> <bun> <bridge-dir> <home> <liaison-home> <path>
render_service_template() {
  local t="$1" out="$2" tmp name val
  tmp="$(mktemp "${TMPDIR:-/tmp}/liaison-render.XXXXXX")" || return 1
  cp "$t" "$tmp" || { rm -f "$tmp"; return 1; }
  for name in BUN BRIDGE_DIR HOME LIAISON_HOME PATH; do
    case "$name" in BUN) val="$3" ;; BRIDGE_DIR) val="$4" ;; HOME) val="$5" ;; LIAISON_HOME) val="$6" ;; PATH) val="$7" ;; esac
    case "$t" in  # plists are XML: escape the three characters that would break the file
      *.plist.tmpl) val="$(printf '%s' "$val" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')" ;;
    esac
    val="$(printf '%s' "$val" | sed -e 's/[\\|&]/\\&/g')"
    sed -e "s|{$name}|$val|g" "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp" || { rm -f "$tmp" "$tmp.next"; return 1; }
  done
  mkdir -p "$(dirname "$out")" && cat "$tmp" > "$out"
  rm -f "$tmp"
}

# autostart_install: renders and loads the service for this platform. Returns 1 when it cannot (caller falls back).
autostart_install() {
  local bun dest tmpl svc_path
  bun="$(daemon_bun_path)" || return 1
  svc_path="$(dirname "$bun"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  if is_macos; then
    command -v launchctl >/dev/null 2>&1 || return 1
    dest="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
    tmpl="$LIAISON_REPO/bridge/service/liaison-bridge.plist.tmpl"
    render_service_template "$tmpl" "$dest" "$bun" "$LIAISON_REPO/bridge" "$HOME" "$LIAISON_HOME" "$svc_path" || { rm -f "$dest"; return 1; }
    launchctl bootout "gui/$(id -u)/$SERVICE_NAME" >/dev/null 2>&1
    launchctl bootstrap "gui/$(id -u)" "$dest" || { rm -f "$dest"; return 1; }
    echo launchd
  else
    command -v systemctl >/dev/null 2>&1 || return 1
    dest="$HOME/.config/systemd/user/$SERVICE_NAME.service"
    tmpl="$LIAISON_REPO/bridge/service/liaison-bridge.service.tmpl"
    render_service_template "$tmpl" "$dest" "$bun" "$LIAISON_REPO/bridge" "$HOME" "$LIAISON_HOME" "$svc_path" || { rm -f "$dest"; return 1; }
    systemctl --user daemon-reload && systemctl --user enable --now "$SERVICE_NAME.service" || { rm -f "$dest"; return 1; }
    echo systemd
  fi
}

step_daemon() {
  local kind detail bun
  if [ "$(state_get daemon)" = ok ]; then
    detail="$(state_detail daemon)"
    case "$detail" in
      manual*) daemon_live_pid >/dev/null && return 0
               say "daemon: was not running; starting it" ;;
      *)       return 0 ;;
    esac
  fi
  bun="$(daemon_bun_path)" || { echo "liaison: bun not found; re-run ./setup" >&2; exit 1; }
  if [ ! -d "$LIAISON_REPO/bridge/node_modules" ]; then
    say "installing bridge dependencies"
    ( cd "$LIAISON_REPO/bridge" && "$bun" install --frozen-lockfile >&2 ) || die "bun install failed in $LIAISON_REPO/bridge"
  fi
  if [ "${OPT_NO_AUTOSTART:-0}" != 1 ] && confirm "Start the bridge automatically at login?" y; then
    daemon_stop >/dev/null 2>&1
    if kind="$(autostart_install)"; then
      state_set daemon ok "autostart via $kind"
      say "daemon: autostart installed ($kind)"
      WORK=1
      return 0
    fi
    echo "liaison: could not install the autostart service; starting the daemon by hand instead." >&2
  fi
  daemon_start || exit 1
  state_set daemon ok "manual start"
  WORK=1
}

# --- 5. office channel and greeting ----------------------------------------------------------------------

step_office_channel() {
  local chan rc
  [ "$(state_get office_channel)" = ok ] && return 0
  chan="$(ask "Office channel name" "$(config_get office_channel)")"
  case "$chan" in
    ''|-*|*[!a-z0-9_-]*) bad_input "channel names use lowercase letters, digits, - and _; got '$chan'" ;;
  esac
  [ "${#chan}" -le 80 ] || bad_input "channel names are at most 80 characters"
  LIAISON_ROOT="$LIAISON_HOME" "$(bridge_cmd slack-register)" --office "$LIAISON_OFFICE" --channel "$chan"
  rc=$?
  [ "$rc" -eq 0 ] || die "slack-register failed (exit $rc)"
  config_set office_channel "$chan" || exit 1
  state_set office_channel ok "$chan"
  WORK=1
}

# greeting_wait <slug> <id>: polls the bridge state for up to VERIFY_WAIT_S seconds; prints the last answer
# (posted | pending | paused | missing | error:<reason>), stopping early on anything but pending.
greeting_wait() {
  local st="" start now
  start="$(date +%s)"
  while :; do
    st="$(_verify_delivery "$LIAISON_HOME" "$1" "$2")"
    [ "$st" = pending ] || break
    now="$(date +%s)"
    [ $((now - start)) -lt "$VERIFY_WAIT_S" ] || break
    sleep 0.2
  done
  printf '%s\n' "$st"
}

GREETING_PENDING=0

step_greeting() {
  local tmpl text name chan rc out slug id st detail
  [ "$(state_get greeting)" = ok ] && return 0
  WORK=1
  chan="$(config_get office_channel)"
  # A greeting queued by an earlier run is checked again instead of being sent twice.
  detail="$(state_detail greeting)"
  case "$detail" in
    "queued "*)
      set -- $detail
      slug="$2"; id="${3%;}"
      st="$(greeting_wait "$slug" "$id")"
      case "$st" in
        posted) state_set greeting ok "delivered to #$chan"; say "greeting: delivered"; return 0 ;;
        pending) GREETING_PENDING=1
                 say "greeting: queued, not delivered yet; check $LIAISON_HOME/daemon.log, then run: liaison verify"
                 return 0 ;;
      esac ;;
  esac
  tmpl="$LIAISON_REPO/templates/greeting.md"
  [ -f "$tmpl" ] || die "missing $tmpl"
  text="$(cat "$tmpl")"
  name="$(config_get owner_name)"; [ -n "$name" ] || name="there"
  text="${text//\{owner_name\}/$name}"
  text="${text//\{office_channel\}/$chan}"
  out="$(cd "$LIAISON_OFFICE" && LIAISON_ROOT="$LIAISON_HOME" "$(bridge_cmd slack-say)" "$text" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || die "slack-say failed (exit $rc); the greeting was not queued"
  # slack-say prints `queued -> <slug> (<id>)`; the id is what the delivery check follows.
  slug="$(printf '%s\n' "$out" | sed -n 's/.*queued -> \([A-Za-z0-9_-]*\) (\(say_[A-Za-z0-9_]*\)).*/\1/p' | head -n 1)"
  id="$(printf '%s\n' "$out" | sed -n 's/.*queued -> \([A-Za-z0-9_-]*\) (\(say_[A-Za-z0-9_]*\)).*/\2/p' | head -n 1)"
  st=pending
  [ -n "$slug" ] && [ -n "$id" ] && st="$(greeting_wait "$slug" "$id")"
  case "$st" in
    posted)
      state_set greeting ok "delivered to #$chan"
      say "greeting: delivered" ;;
    *)
      GREETING_PENDING=1
      if [ -n "$slug" ] && [ -n "$id" ] && [ "$st" = pending ]; then
        state_set greeting missing "queued $slug $id; not delivered yet (check $LIAISON_HOME/daemon.log, then: liaison verify)"
      else
        state_set greeting missing "queued, delivery not confirmed ($st); check $LIAISON_HOME/daemon.log, then: liaison verify"
      fi
      say "greeting: queued, not delivered yet — check $LIAISON_HOME/daemon.log, then run: liaison verify" ;;
  esac
}

# --- 6. engine layer -------------------------------------------------------------------------------------

step_engine() {
  local inst="$LIAISON_REPO/engines/claude/install.sh"
  if [ -f "$inst" ]; then
    [ "$(state_get engine)" = ok ] && return 0
    /bin/bash "$inst" "$LIAISON_OFFICE" || die "engine install failed ($inst)"
    state_set engine ok
    WORK=1
    return 0
  fi
  [ "$(state_get engine)" = missing ] || return 0
  state_set engine skipped "engine layer not installed yet"
  WORK=1
}

# --- 7. PATH symlinks and shell aliases ------------------------------------------------------------------

# link_target_is_ours <link> <dir>: true when the symlink's target lies inside this checkout or the office.
link_target_is_ours() {
  local t
  t="$(readlink "$1")" || return 1
  case "$t" in /*) ;; *) t="$2/$t" ;; esac
  case "$t" in
    "$LIAISON_REPO"/*|"$LIAISON_OFFICE"/*) return 0 ;;
  esac
  return 1
}

step_path() {
  local dir="$HOME/.local/bin" f name detail="symlinks in ~/.local/bin" skipped=0
  case "$(state_get path)" in ok|skipped) return 0 ;; esac   # a decline is remembered; --yes does not undo it
  if ! confirm "Link liaison and the slack-* commands into ~/.local/bin?" y; then
    state_set path skipped "declined; run them from $LIAISON_REPO/bin and $LIAISON_REPO/bridge/bin (to link later, delete the path entry in .liaison/state.json and re-run ./setup)"
    WORK=1
    return 0
  fi
  mkdir -p "$dir" || die "cannot create $dir"
  for f in "$LIAISON_REPO/bin/liaison" "$LIAISON_REPO"/bridge/bin/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    if [ -L "$dir/$name" ]; then
      if ! link_target_is_ours "$dir/$name" "$dir"; then
        echo "warning: ~/.local/bin/$name already exists and points elsewhere; left untouched" >&2
        skipped=$((skipped + 1))
        continue
      fi
    elif [ -e "$dir/$name" ]; then
      echo "warning: ~/.local/bin/$name already exists and is not a symlink; left untouched" >&2
      skipped=$((skipped + 1))
      continue
    fi
    ln -sfn "$f" "$dir/$name" || die "cannot link $dir/$name"
  done
  [ "$skipped" -eq 0 ] || detail="$detail; $skipped left untouched"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      cat >&2 <<EOM
warning: ~/.local/bin is not on your PATH, so 'liaison' and 'slack-say' will not be found in new shells.
Add this line to your shell rc file, then open a new terminal:
  export PATH="\$HOME/.local/bin:\$PATH"
EOM
      ;;
  esac
  state_set path ok "$detail"
  WORK=1
}

rc_file_for_shell() {
  case "$(basename "${SHELL:-}")" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
  esac
}

step_aliases() {
  local engine_script="$LIAISON_REPO/engines/claude/aliases.sh" rc mode block cur tmp
  [ "${OPT_NO_ALIASES:-0}" = 1 ] && return 0
  [ "$(state_get aliases)" = skipped ] && return 0   # a decline is remembered; --yes does not undo it
  [ -f "$engine_script" ] || return 0
  mode="$(config_get permission_mode)"
  block="$(printf '# liaison start\n'; /bin/bash "$engine_script" "$mode"; printf '# liaison end\n')"
  rc="$(rc_file_for_shell)"
  if [ -z "$rc" ]; then
    [ "$WORK" = 1 ] && { say "Your shell (${SHELL:-unknown}) is not bash or zsh. Add these lines to its rc file if you want them:"; say "$block"; }
    return 0
  fi
  cur=""
  [ -f "$rc" ] && cur="$(awk '/^# liaison start$/{p=1} p{print} /^# liaison end$/{p=0}' "$rc")"
  [ "$cur" = "$block" ] && return 0
  if [ -z "$cur" ] && ! confirm "Add the claude3/claude5 shell aliases to $rc?" y; then
    state_set aliases skipped "declined; the lines are in engines/claude/aliases.sh"
    WORK=1
    return 0
  fi
  tmp="$(mktemp "$rc.liaison.XXXXXX" 2>/dev/null || mktemp "${TMPDIR:-/tmp}/liaison-rc.XXXXXX")" || die "mktemp failed"
  printf '%s\n' "$block" > "$tmp.block"
  if [ -z "$cur" ]; then
    [ -f "$rc" ] || : > "$rc"
    { [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ] && printf '\n'; [ -s "$rc" ] && printf '\n'; cat "$tmp.block"; } >> "$rc"
  else
    [ "$(grep -c '^# liaison start$' "$rc")" = 1 ] && [ "$(grep -c '^# liaison end$' "$rc")" = 1 ] \
      || { rm -f "$tmp" "$tmp.block"; die "$rc has a damaged '# liaison' block; fix or delete it and re-run ./setup"; }
    # Build the new file next to the rc (same mode: cp -p first), then swap it in; a failed awk leaves the rc untouched.
    cp -p "$rc" "$tmp" \
      && awk -v bf="$tmp.block" '/^# liaison start$/{while((getline l < bf)>0) print l; skip=1; next} /^# liaison end$/{skip=0; next} !skip{print}' "$rc" > "$tmp" \
      || { rm -f "$tmp" "$tmp.block"; die "could not rewrite $rc"; }
    if [ -L "$rc" ]; then cat "$tmp" > "$rc"; else mv "$tmp" "$rc"; fi   # a symlinked rc keeps its link
  fi
  rm -f "$tmp" "$tmp.block"
  say "aliases: written to $rc (open a new terminal to use them)"
  WORK=1
}
