#!/usr/bin/env python3
"""liaison context guard: a Claude Code hook for PostToolUse, Stop and SessionStart.

It reports how full the context window is, and for sessions registered with
`liaison guard register` it makes sure the coordinator keeps a fresh handoff file
and keeps its Slack wait armed across compaction. Unregistered sessions only get
the context line and a gentle reminder. Subagents are never touched.

Reads the hook event as JSON on stdin. Always exits 0; prints nothing when there
is nothing to say. Errors go to <guard dir>/hook.log, never to the session.
Standard library only.
"""
import json
import os
import re
import subprocess
import sys
import time

STEP = 50000            # report every time the context crosses another 50k tokens
WARN_AT = 0.65          # start asking for a handoff at 65% of the window ...
WARN_EVERY = 0.10       # ... and again every further 10%
STOP_AT = 0.75          # at 75% the handoff must be fresh before the turn may end
DEFAULT_WINDOW = 200000
TAIL_BYTES = 3 * 1024 * 1024
STATUS_TIMEOUT = 8


def guard_dir_for(office):
    state = os.environ.get("LIAISON_STATE_DIR")
    if state:
        return os.path.join(state, "guard")
    return os.path.join(office, ".liaison", "guard")


def read_json(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def log(gdir, message):
    try:
        os.makedirs(gdir, exist_ok=True)
        with open(os.path.join(gdir, "hook.log"), "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), message))
    except Exception:
        pass


def context_tokens(transcript_path):
    """Tokens in use according to the last main-thread assistant turn, or None."""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            tail = f.read().decode("utf-8", "replace")
    except Exception:
        return None
    for line in reversed(tail.split("\n")):  # not splitlines(): it also splits on U+2028 and friends
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("model") == "<synthetic>":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        total = 0
        for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"):
            value = usage.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                total += int(value)
        return total
    return None


def window_size(office):
    """env CLAUDE_CODE_AUTO_COMPACT_WINDOW, then autoCompactWindow in the settings files, then 200000."""
    env = os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "")
    if env.isdigit() and int(env) > 0:
        return int(env)
    home = os.path.expanduser("~")
    for path in (
        os.path.join(office, ".claude", "settings.local.json"),
        os.path.join(office, ".claude", "settings.json"),
        os.path.join(home, ".claude", "settings.json"),
    ):
        value = read_json(path).get("autoCompactWindow")
        if isinstance(value, str) and value.isdigit():
            value = int(value)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return DEFAULT_WINDOW


def safe_name(session_id):
    return re.sub(r"[^A-Za-z0-9._-]", "_", session_id)


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def additional_context(event, text):
    emit({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})


def wait_is_armed(reg, gdir):
    """Run `<wait> --status`; any failure of our own counts as armed (never block on ourselves).

    Exit 126/127 (not executable / not found) means the wait command itself is broken, so it is logged and
    treated as armed: blocking every Stop on a command that can never run would trap the session.
    """
    try:
        cwd = reg.get("dir") if os.path.isdir(str(reg.get("dir"))) else None
        proc = subprocess.run(
            "%s --status" % reg["wait"], shell=True, cwd=cwd, timeout=STATUS_TIMEOUT,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if proc.returncode in (126, 127):
            log(gdir, "wait command %r exited %d (not found / not executable); treating as armed" % (reg["wait"], proc.returncode))
            return True
        return proc.returncode == 0
    except Exception:
        return True


def fmt_k(tokens):
    return "%dk" % (tokens // 1000)


def on_post_tool_use(ctx):
    tokens, window, state, reg = ctx["tokens"], ctx["window"], ctx["state"], ctx["reg"]
    pct = int(tokens * 100 / window)
    parts = []
    before = {k: v for k, v in state.items() if k != "last_tokens"}

    step = tokens // STEP
    last_step = state.get("last_step", 0)
    last_tokens = state.get("last_tokens")
    compacted = last_tokens is not None and last_tokens - tokens > STEP
    if step > last_step or compacted:
        parts.append("[liaison] context %s/%s (%d%%)" % (fmt_k(tokens), fmt_k(window), pct))
        state["last_step"] = step
    state["last_tokens"] = tokens

    if compacted:
        state.pop("warned_ctx", None)
        state.pop("warned_at", None)
    warned_ctx = state.get("warned_ctx")
    if tokens >= WARN_AT * window and (warned_ctx is None or tokens >= warned_ctx + WARN_EVERY * window):
        if reg:
            parts.append(
                "Context is at %d%%: rewrite the STATE NOW block at the top of your handoff %s now "
                "(<= 6000 chars: mandate, current state with a `date -u` time, queue, exact commands, "
                "slack-wait command) so it survives compaction." % (pct, reg["handoff"])
            )
        else:
            parts.append(
                "Context is at %d%%: save what you need to remember after compaction to a file." % pct
            )
        state["warned_ctx"] = tokens
        state["warned_at"] = time.time()

    # Registered sessions always persist (last_tokens drives compaction detection). Unregistered ones only when
    # something worth remembering changed, so they do not litter the guard dir on every tool call.
    after = {k: v for k, v in state.items() if k != "last_tokens"}
    if reg or after != before:
        write_json(ctx["state_path"], state)
    if parts:
        additional_context("PostToolUse", "\n".join(parts))


def on_stop(ctx):
    reg, state = ctx["reg"], ctx["state"]
    if not reg or ctx["input"].get("stop_hook_active"):
        return
    reasons = []
    if not wait_is_armed(reg, ctx["gdir"]):
        reasons.append("Your Slack wait is not armed. Arm it with Bash run_in_background: %s" % reg["wait"])
    tokens, window = ctx["tokens"], ctx["window"]
    warned_at = state.get("warned_at")
    if tokens is not None and warned_at is not None and tokens >= STOP_AT * window:
        try:
            mtime = os.path.getmtime(reg["handoff"])
        except OSError:
            mtime = 0
        if mtime < warned_at:
            reasons.append(
                "Context %d/%d (%d%%) and your handoff %s was not updated since the warning. "
                "Rewrite its STATE NOW block now." % (tokens, window, int(tokens * 100 / window), reg["handoff"])
            )
    if reasons:
        emit({"decision": "block", "reason": " ".join(reasons)})


def on_session_start(ctx):
    if ctx["input"].get("source") != "compact":
        return
    reg, state = ctx["reg"], ctx["state"]
    state["compacted_at"] = time.time()
    state.pop("warned_ctx", None)
    state.pop("warned_at", None)
    state.pop("last_tokens", None)
    state["last_step"] = 0
    write_json(ctx["state_path"], state)
    if reg:
        text = (
            "Your context was just compacted. Before anything else, read the STATE NOW block at the top of "
            "your handoff %s (first 150 lines), then re-arm your Slack wait with Bash run_in_background: %s"
            % (reg["handoff"], reg["wait"])
        )
    else:
        text = "Your context was just compacted. If you keep a handoff or memory of the work in progress, re-read it before continuing."
    additional_context("SessionStart", text)


def main():
    data = json.load(sys.stdin)
    if not isinstance(data, dict) or data.get("agent_id"):
        return  # malformed input, or a subagent: it has no handoff
    event = data.get("hook_event_name")
    session_id = data.get("session_id")
    if event not in ("PostToolUse", "Stop", "SessionStart") or not isinstance(session_id, str) or not session_id:
        return
    office = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    gdir = guard_dir_for(office)
    try:
        name = safe_name(session_id)
        reg = read_json(os.path.join(gdir, name + ".json"))
        if not (reg.get("handoff") and reg.get("wait")):
            reg = None
        state_path = os.path.join(gdir, name + ".state.json")
        ctx = {
            "input": data, "reg": reg, "state_path": state_path, "state": read_json(state_path),
            "window": window_size(office), "tokens": None, "gdir": gdir,
        }
        if event == "Stop" and not reg:
            return
        if event != "SessionStart":
            ctx["tokens"] = context_tokens(data.get("transcript_path") or "")
            if ctx["tokens"] is None and event == "PostToolUse":
                return  # Stop still checks the wait without a count
        {"PostToolUse": on_post_tool_use, "Stop": on_stop, "SessionStart": on_session_start}[event](ctx)
    except Exception as exc:
        log(gdir, "%s: %r" % (event, exc))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            log(guard_dir_for(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()), "fatal: %r" % (exc,))
        except Exception:
            pass
    sys.exit(0)
