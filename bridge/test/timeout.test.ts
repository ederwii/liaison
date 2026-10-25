import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { makeRig, OWNER, T0, type Rig } from "./harness.ts";
import { ACTION_CHOICE, encodeValue } from "../src/blocks.ts";

let rig: Rig;
beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

async function askWith(over: Record<string, unknown>) {
  rig.push("alpha", { kind: "ask", question_id: "q1", text: "Ship it?", qtype: "buttons",
    options: ["A", "B"], timeout_ms: 60_000, ...over } as any);
  await rig.daemon.pump();
  return rig.daemon.openQuestions()[0]!;
}

describe("§4.3 timeout is explicit — never a silent stall", () => {
  test("nothing happens before the deadline", async () => {
    await askWith({ default: "B", on_timeout: "default" });
    rig.clock.t = T0 + 59_000;
    await rig.daemon.tick();
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.openQuestions()).toHaveLength(1);
  });

  test("on-timeout=default applies the default AND announces it in the thread", async () => {
    const q = await askWith({ default: "B", on_timeout: "default" });
    rig.clock.t = T0 + 60_001;
    await rig.daemon.tick();
    const [line] = rig.inbox("alpha");
    expect(line).toMatchObject({
      kind: "answer", question_id: "q1", choice: "B",
      from: "system", via: "timeout-default",
      answered_by: "system:timeout", executed_by: "system:timeout",
      authority: "system-default",
    });
    const announcement = rig.tx.thread(q.thread_ts).at(-1)!;
    expect(announcement.threadTs).toBe(q.thread_ts);
    expect(announcement.text).toMatch(/timed out/i);
    expect(announcement.text).toContain("B");
    expect(rig.daemon.openQuestions()).toHaveLength(0);
  });

  test("a click that lands after the default was applied is ignored", async () => {
    const q = await askWith({ default: "B", on_timeout: "default" });
    rig.clock.t = T0 + 60_001;
    await rig.daemon.tick();
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    expect(rig.inbox("alpha")).toHaveLength(1);
    expect(rig.inbox("alpha")[0].choice).toBe("B");
  });

  test("on-timeout=escalate @mentions once and KEEPS the question open", async () => {
    const q = await askWith({ default: null, on_timeout: "escalate" });
    rig.clock.t = T0 + 60_001;
    await rig.daemon.tick();
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.openQuestions()).toHaveLength(1);
    const nudge = rig.tx.thread(q.thread_ts).at(-1)!;
    expect(nudge.text).toContain(`<@${OWNER}>`);
    // and it does not nag on every tick
    rig.clock.t = T0 + 120_000;
    await rig.daemon.tick();
    await rig.daemon.tick();
    const mentions = rig.tx.thread(q.thread_ts).filter((p) => p.text.includes(`<@${OWNER}>`));
    expect(mentions).toHaveLength(1);
    // the human can still answer afterwards
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    expect(rig.inbox("alpha")[0]).toMatchObject({ choice: "A", via: "slack" });
  });

  test("on-timeout=block tells the session it is blocked instead of guessing", async () => {
    const q = await askWith({ default: null, on_timeout: "block" });
    rig.clock.t = T0 + 60_001;
    await rig.daemon.tick();
    const [line] = rig.inbox("alpha");
    expect(line).toMatchObject({ kind: "blocked", question_id: "q1", reason: "timeout_block" });
    expect(rig.tx.thread(q.thread_ts).at(-1)!.text).toMatch(/blocked/i);
    expect(rig.daemon.openQuestions()).toHaveLength(0);
  });

  test("on-timeout=default with no default is rejected at post time, not at expiry", async () => {
    rig.push("alpha", { kind: "ask", question_id: "bad", text: "?", qtype: "buttons",
      options: ["A"], timeout_ms: 60_000, default: null, on_timeout: "default" } as any);
    await rig.daemon.pump();
    const [line] = rig.inbox("alpha");
    expect(line.kind).toBe("error");
    expect(line.reason).toMatch(/default/i);
    expect(rig.tx.posts).toHaveLength(0);
  });

  test("timeout_ms null means no timer is ever armed", async () => {
    await askWith({ timeout_ms: null, default: null, on_timeout: "escalate" });
    rig.clock.t = T0 + 86_400_000 * 30;
    await rig.daemon.tick();
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.openQuestions()).toHaveLength(1);
  });
});
