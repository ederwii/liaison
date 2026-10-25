"""Tests for hooks/context-guard.py. Stdlib only: each test runs the hook as a subprocess."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "context-guard.py")
SESSION = "sess-1"


class GuardCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = os.path.realpath(self._tmp.name)
        self.office = os.path.join(self.tmp, "office")
        self.home = os.path.join(self.tmp, "home")
        self.bin = os.path.join(self.tmp, "bin")
        self.state_dir = os.path.join(self.tmp, "state")
        self.guard_dir = os.path.join(self.state_dir, "guard")
        self.transcript = os.path.join(self.tmp, "transcript.jsonl")
        for d in (self.office, self.home, self.bin, self.guard_dir):
            os.makedirs(d)
        self.handoff = os.path.join(self.tmp, "handoff.md")
        with open(self.handoff, "w") as f:
            f.write("# STATE NOW\n")

    # -- helpers ----------------------------------------------------------
    def write_transcript(self, tokens, extra_lines=()):
        """One main-thread assistant turn whose usage sums to `tokens`."""
        line = {
            "type": "assistant",
            "message": {
                "model": "claude-test",
                "usage": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": tokens - 40,
                    "cache_creation_input_tokens": 20,
                    "output_tokens": 10,
                },
            },
        }
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n")
            f.write(json.dumps(line) + "\n")
            for extra in extra_lines:
                f.write(extra + "\n")

    def fake_wait(self, armed):
        path = os.path.join(self.bin, "slack-wait")
        body = "#!/bin/sh\necho armed\nexit 0\n" if armed else "#!/bin/sh\necho 'NOT armed'\nexit 1\n"
        with open(path, "w") as f:
            f.write(body)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)

    def register(self, wait="slack-wait"):
        with open(os.path.join(self.guard_dir, SESSION + ".json"), "w") as f:
            json.dump({"handoff": self.handoff, "wait": wait, "dir": self.office, "registered_at": "2026-01-01T00:00:00Z"}, f)

    def state(self):
        p = os.path.join(self.guard_dir, SESSION + ".state.json")
        if not os.path.exists(p):
            return {}
        with open(p) as f:
            return json.load(f)

    def run_hook(self, event, window="500000", extra=None, env_extra=None):
        payload = {
            "hook_event_name": event,
            "session_id": SESSION,
            "transcript_path": self.transcript,
            "cwd": self.office,
        }
        payload.update(extra or {})
        env = {
            "PATH": self.bin + os.pathsep + os.environ.get("PATH", ""),
            "HOME": self.home,
            "LIAISON_STATE_DIR": self.state_dir,
        }
        if window is not None:
            env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = window
        env.update(env_extra or {})
        proc = subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def context_of(self, out):
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]


class ContextGuardTests(GuardCase):
    def test_unregistered_session_is_noop(self):
        self.fake_wait(armed=False)
        self.write_transcript(450000)
        out = self.run_hook("Stop")
        self.assertEqual(out, "")

    def test_posttooluse_reports_every_50k(self):
        self.write_transcript(30000)
        self.assertEqual(self.run_hook("PostToolUse"), "")
        self.write_transcript(150000)
        out = self.run_hook("PostToolUse")
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertEqual(self.context_of(out), "[liaison] context 150k/500k (30%)")
        # Same 50k step again: silent.
        self.write_transcript(160000)
        self.assertEqual(self.run_hook("PostToolUse"), "")
        # Next step reports again.
        self.write_transcript(205000)
        self.assertEqual(self.context_of(self.run_hook("PostToolUse")), "[liaison] context 205k/500k (41%)")
        # A drop of more than 50k (compaction) reports the new, lower level.
        self.write_transcript(100000)
        self.assertEqual(self.context_of(self.run_hook("PostToolUse")), "[liaison] context 100k/500k (20%)")

    def test_unregistered_posttooluse_asks_to_save_to_a_file_at_65_percent(self):
        self.write_transcript(330000)
        text = self.context_of(self.run_hook("PostToolUse"))
        self.assertIn("[liaison] context 330k/500k (66%)", text)
        self.assertIn("save what you need to remember after compaction to a file", text)
        self.assertNotIn(self.handoff, text)

    def test_registered_posttooluse_asks_to_rewrite_state_now_then_every_10_percent(self):
        self.register()
        self.write_transcript(330000)
        text = self.context_of(self.run_hook("PostToolUse"))
        self.assertIn("rewrite the STATE NOW block at the top of your handoff " + self.handoff, text)
        self.assertIn("6000 chars", text)
        self.assertIn("date -u", text)
        self.assertIn("warned_at", self.state())
        # Still inside the same 10% band: no second reminder.
        self.write_transcript(340000)
        self.assertNotIn("STATE NOW", self.run_hook("PostToolUse"))
        # 10% of the window further (380k = +50k): reminder again.
        self.write_transcript(385000)
        self.assertIn("STATE NOW", self.context_of(self.run_hook("PostToolUse")))

    def test_registered_stop_blocks_without_wait(self):
        self.register()
        self.fake_wait(armed=False)
        self.write_transcript(100000)
        out = self.run_hook("Stop")
        data = json.loads(out)
        self.assertEqual(data["decision"], "block")
        self.assertIn("Your Slack wait is not armed. Arm it with Bash run_in_background: slack-wait", data["reason"])

    def test_registered_stop_passes_when_armed(self):
        self.register()
        self.fake_wait(armed=True)
        self.write_transcript(100000)
        self.assertEqual(self.run_hook("Stop"), "")

    def test_registered_stop_blocks_when_handoff_stale_after_warning(self):
        self.register()
        self.fake_wait(armed=True)
        self.write_transcript(400000)
        self.run_hook("PostToolUse")  # records warned_at
        warned_at = self.state()["warned_at"]
        os.utime(self.handoff, (warned_at - 100, warned_at - 100))
        out = self.run_hook("Stop")
        reason = json.loads(out)["reason"]
        self.assertIn("Context 400000/500000 (80%)", reason)
        self.assertIn("was not updated since the warning", reason)
        # Handoff touched after the warning: passes.
        os.utime(self.handoff, (time.time() + 5, time.time() + 5))
        self.assertEqual(self.run_hook("Stop"), "")

    def test_window_precedence_env_over_settings(self):
        os.makedirs(os.path.join(self.office, ".claude"))
        os.makedirs(os.path.join(self.home, ".claude"))
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"autoCompactWindow": 300000}, f)
        self.write_transcript(150000)
        # user settings only
        self.assertIn("150k/300k (50%)", self.context_of(self.run_hook("PostToolUse", window=None)))
        os.remove(os.path.join(self.guard_dir, SESSION + ".state.json"))
        # project settings beat user settings
        with open(os.path.join(self.office, ".claude", "settings.json"), "w") as f:
            json.dump({"autoCompactWindow": 400000}, f)
        self.assertIn("150k/400k (37%)", self.context_of(self.run_hook("PostToolUse", window=None)))
        os.remove(os.path.join(self.guard_dir, SESSION + ".state.json"))
        # local settings beat project settings
        with open(os.path.join(self.office, ".claude", "settings.local.json"), "w") as f:
            json.dump({"autoCompactWindow": 250000}, f)
        self.assertIn("150k/250k (60%)", self.context_of(self.run_hook("PostToolUse", window=None)))
        os.remove(os.path.join(self.guard_dir, SESSION + ".state.json"))
        # env beats everything
        self.assertIn("150k/500k (30%)", self.context_of(self.run_hook("PostToolUse", window="500000")))
        os.remove(os.path.join(self.guard_dir, SESSION + ".state.json"))
        # nothing set: default 200000
        for p in (os.path.join(self.office, ".claude", "settings.json"), os.path.join(self.office, ".claude", "settings.local.json"), os.path.join(self.home, ".claude", "settings.json")):
            os.remove(p)
        self.assertIn("150k/200k (75%)", self.context_of(self.run_hook("PostToolUse", window=None)))

    def test_compact_start_message(self):
        self.register()
        self.write_transcript(20000)
        out = self.run_hook("SessionStart", extra={"source": "compact"})
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["hookEventName"], "SessionStart")
        text = self.context_of(out)
        self.assertIn("Your context was just compacted.", text)
        self.assertIn("read the STATE NOW block at the top of your handoff " + self.handoff + " (first 150 lines)", text)
        self.assertIn("re-arm your Slack wait with Bash run_in_background: slack-wait", text)
        self.assertIn("compacted_at", self.state())

    def test_compact_start_message_unregistered(self):
        text = self.context_of(self.run_hook("SessionStart", extra={"source": "compact"}))
        self.assertIn("If you keep a handoff or memory of the work in progress, re-read it before continuing.", text)

    def test_non_compact_session_start_is_silent(self):
        self.register()
        self.assertEqual(self.run_hook("SessionStart", extra={"source": "startup"}), "")

    def test_subagent_events_are_noop(self):
        self.register()
        self.fake_wait(armed=False)
        self.write_transcript(450000)
        for event, extra in (("PostToolUse", {}), ("Stop", {}), ("SessionStart", {"source": "compact"})):
            extra = dict(extra, agent_id="agent-7")
            self.assertEqual(self.run_hook(event, extra=extra), "", event)
        self.assertEqual(self.state(), {})

    def test_stop_hook_active_is_noop(self):
        self.register()
        self.fake_wait(armed=False)
        self.write_transcript(100000)
        self.assertEqual(self.run_hook("Stop", extra={"stop_hook_active": True}), "")

    def test_transcript_ignores_sidechain_and_synthetic(self):
        sidechain = json.dumps({"type": "assistant", "isSidechain": True, "message": {"model": "m", "usage": {"input_tokens": 400000}}})
        synthetic = json.dumps({"type": "assistant", "message": {"model": "<synthetic>", "usage": {"input_tokens": 400000}}})
        self.write_transcript(150000, extra_lines=[sidechain, synthetic, "not json at all"])
        self.assertIn("150k/500k", self.context_of(self.run_hook("PostToolUse")))

    def test_stop_checks_wait_even_without_a_token_count(self):
        self.register()
        self.fake_wait(armed=False)  # no transcript written at all
        reason = json.loads(self.run_hook("Stop"))["reason"]
        self.assertIn("Your Slack wait is not armed", reason)
        self.assertNotIn("handoff", reason)

    def test_raw_unicode_line_separator_in_transcript_does_not_hide_the_last_turn(self):
        self.write_transcript(100000)
        newest = {"type": "assistant", "message": {"model": "m", "content": [{"type": "text", "text": "a\u2028b\u2029c\x85d"}],
                  "usage": {"input_tokens": 160000}}}
        with open(self.transcript, "a", encoding="utf-8") as f:
            f.write(json.dumps(newest, ensure_ascii=False) + "\n")
        with open(self.transcript, encoding="utf-8") as f:
            self.assertIn("\u2028", f.read())  # really raw, not escaped
        self.assertIn("160k/500k", self.context_of(self.run_hook("PostToolUse")))

    def test_unregistered_session_does_not_litter_the_guard_dir(self):
        self.write_transcript(30000)
        self.run_hook("PostToolUse")
        self.run_hook("PostToolUse")
        self.assertEqual(os.listdir(self.guard_dir), [])
        self.write_transcript(150000)  # a reported crossing is a real change: state is saved
        self.run_hook("PostToolUse")
        self.assertEqual(os.listdir(self.guard_dir), [SESSION + ".state.json"])

    def test_broken_wait_command_is_treated_as_armed_and_logged(self):
        self.register(wait="no-such-wait-command-xyz")
        self.write_transcript(100000)
        self.assertEqual(self.run_hook("Stop"), "")
        with open(os.path.join(self.guard_dir, "hook.log")) as f:
            log = f.read()
        self.assertIn("no-such-wait-command-xyz", log)
        self.assertIn("treating as armed", log)

    def test_no_usage_is_noop_and_garbage_input_never_fails(self):
        with open(self.transcript, "w") as f:
            f.write(json.dumps({"type": "user"}) + "\n")
        self.assertEqual(self.run_hook("PostToolUse"), "")
        proc = subprocess.run([sys.executable, HOOK], input="{not json", capture_output=True, text=True, timeout=30)
        self.assertEqual((proc.returncode, proc.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
