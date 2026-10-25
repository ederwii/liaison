#!/bin/bash
# Skills and templates: frontmatter, size, every referenced command exists, greeting placeholders.
. "$(dirname "$0")/harness.sh"
cd "$REPO_ROOT" || exit 2

SKILLS="liaison-setup coordinator slack-bridge release"
TEMPLATES="greeting.md HANDOFF.md HANDOFF-log.md owner-questionnaire.md learn-brief.md project-facts.md"

# --- the expected files exist ---------------------------------------------------------------------------
for s in $SKILLS; do
  [ -f "skills/$s/SKILL.md" ]; assert_eq 0 "$?" "skills/$s/SKILL.md exists"
done
for t in $TEMPLATES; do
  [ -f "templates/$t" ]; assert_eq 0 "$?" "templates/$t exists"
done

# --- frontmatter and size -------------------------------------------------------------------------------
frontmatter() { # frontmatter <file>: prints the lines between the first two '---' lines (file must start with ---)
  awk 'NR==1 { if ($0 != "---") exit; next } $0 == "---" { exit } { print }' "$1"
}

for f in skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  dir="$(basename "$(dirname "$f")")"
  fm="$(frontmatter "$f")"
  assert_eq "name: $dir" "$(printf '%s\n' "$fm" | grep '^name:')" "$f: frontmatter name matches its folder"
  desc="$(printf '%s\n' "$fm" | grep '^description: ' | sed 's/^description: //')"
  [ "${#desc}" -ge 20 ]; assert_eq 0 "$?" "$f: frontmatter has a description (got '$desc')"
  lines="$(wc -l < "$f" | tr -d ' ')"
  [ "$lines" -le 200 ]; assert_eq 0 "$?" "$f: at most 200 lines (has $lines)"
done

# --- every backticked command exists --------------------------------------------------------------------
# Code is what sits in `inline spans` and inside ``` fenced blocks. From it we take every `liaison <sub>` and every
# `slack-<verb>`; a sub must be a case label in bin/liaison, a verb must be bridge/bin/slack-<verb>. A token that is
# one of the skill names in $SKILLS (the slack-bridge skill) is not a command.
code_of() { # code_of <file>: prints inline code spans and fenced-block lines, one per line
  awk '
    /^[[:space:]]*```/ { fence = !fence; next }
    fence { print; next }
    {
      line = $0
      while (match(line, /`[^`]+`/)) {
        print substr(line, RSTART + 1, RLENGTH - 2)
        line = substr(line, RSTART + RLENGTH)
      }
    }' "$1"
}

liaison_sub_exists() { # liaison_sub_exists <sub>: is it a case label (alone or in a|b list) in bin/liaison?
  grep -Eq "^[[:space:]]*([a-z-]+\|)*$1(\|[a-z-]+)*\)" "$REPO_ROOT/bin/liaison"
}

missing_commands() { # missing_commands <file...>: prints "<file>: <command>" for each reference that does not exist
  local f tok sub
  for f in "$@"; do
    for sub in $(code_of "$f" | grep -oE '(^|[^a-z0-9./_-])liaison [a-z][a-z-]*' | sed 's/.*liaison //' | sort -u); do
      liaison_sub_exists "$sub" || echo "$f: liaison $sub"
    done
    for tok in $(code_of "$f" | grep -oE '(^|[^a-z0-9._-])slack-[a-z]+' | sed 's/.*slack-/slack-/' | sort -u); do
      case " $SKILLS " in *" $tok "*) continue ;; esac
      [ -x "$REPO_ROOT/bridge/bin/$tok" ] || echo "$f: $tok"
    done
  done
}

# The checker can see a bad reference (otherwise a clean result below would mean nothing).
probe="$(mktemp "${TMPDIR:-/tmp}/liaison-skill-probe.XXXXXX")" || exit 2
trap 'rm -f "$probe"' EXIT
cat > "$probe" <<'MD'
Run `liaison status` then `liaison bogus-sub`, and `slack-say 'hi'`.
```
slack-nosuchverb --x
liaison guard register --handoff x --wait "slack-wait"
liaison verify
```
The `.liaison/facts/x.md` file and the `slack-bridge` skill are not commands.
MD
got="$(missing_commands "$probe" | sed 's/^[^:]*: //' | tr '\n' ',')"
assert_eq "liaison bogus-sub,slack-nosuchverb," "$got" "checker flags exactly the two bad references"

files=""
for f in skills/*/SKILL.md templates/*.md; do [ -f "$f" ] && files="$files $f"; done
# shellcheck disable=SC2086
bad="$(missing_commands $files)"
assert_eq "" "$bad" "every backticked liaison/slack command in skills and templates exists"

# Each skill references at least one real command (the check above is not vacuous for it).
for s in $SKILLS; do
  [ -f "skills/$s/SKILL.md" ] || continue
  n="$(code_of "skills/$s/SKILL.md" | grep -cE '(liaison [a-z]|slack-[a-z])')"
  [ "$n" -gt 0 ]; assert_eq 0 "$?" "skills/$s/SKILL.md references commands ($n code lines)"
done

# --- greeting placeholders ------------------------------------------------------------------------------
g="$(cat templates/greeting.md 2>/dev/null)"
assert_contains "$g" "{owner_name}" "greeting has {owner_name}"
assert_contains "$g" "{office_channel}" "greeting has {office_channel}"

# --- handoff template carries the STATE NOW skeleton ----------------------------------------------------
h="$(cat templates/HANDOFF.md 2>/dev/null)"
for heading in "STATE NOW" "Mandate" "Now" "Queue" "Exact commands" "Slack wait command" "Open questions" "Rollbacks"; do
  assert_contains "$h" "$heading" "HANDOFF.md template has '$heading'"
done

report
