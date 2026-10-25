import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";
import { ACTION_CHOICE, ACTION_MULTI, ACTION_SUBMIT, encodeValue } from "../src/blocks.ts";

let rig: Rig;
beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

async function ask(over: Record<string, unknown> = {}) {
  const e = rig.push("alpha", { kind: "ask", question_id: "q1", text: "Ship it?", qtype: "buttons", options: ["A", "B", "C"], ...over } as any);
  await rig.daemon.pump();
  return e as any;
}

describe("§4.2 every question gets its own thread, buttons live in the thread", () => {
  test("posts a parent message then the interactive blocks as a thread reply", async () => {
    await ask();
    expect(rig.tx.posts).toHaveLength(2);
    const [parent, blocks] = rig.tx.posts;
    expect(parent!.threadTs).toBeUndefined();
    expect(parent!.text).toContain("Ship it?");
    expect(blocks!.threadTs).toBe(parent!.ts);
    expect(blocks!.blocks).toBeDefined();
  });

  test("thread_ts maps back to the question id", async () => {
    await ask();
    const q = rig.daemon.openQuestions().find((x) => x.question_id === "q1")!;
    expect(q.thread_ts).toBe(rig.tx.posts[0]!.ts);
    expect(q.channel).toBe(channelId(rig, "alpha"));
  });

  test("two concurrent questions get two threads and never cross-answer", async () => {
    await ask({ question_id: "qA", text: "First?" });
    await ask({ question_id: "qB", text: "Second?" });
    const qA = rig.daemon.openQuestions().find((x) => x.question_id === "qA")!;
    const qB = rig.daemon.openQuestions().find((x) => x.question_id === "qB")!;
    expect(qA.thread_ts).not.toBe(qB.thread_ts);
    await rig.tx.clickButton({ channel: qB.channel, user: OWNER, threadTs: qB.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("qB", "C") });
    const lines = rig.inbox("alpha");
    expect(lines).toHaveLength(1);
    expect(lines[0].question_id).toBe("qB");
    expect(rig.daemon.openQuestions().map((q) => q.question_id)).toEqual(["qA"]);
  });
});

describe("§4.2 + §4.5 answers land in the inbox with provenance", () => {
  test("a button click writes one answer line in under one pump", async () => {
    await ask();
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    const [line] = rig.inbox("alpha");
    expect(line).toMatchObject({
      kind: "answer",
      question_id: "q1",
      choice: "A",
      from: OWNER,
      channel: q.channel,
      answered_by: "Owner",
      via: "slack",
      executed_by: "Owner",
      authority: "owner-decision",
    });
    expect(typeof line.slack_ts).toBe("string");
    expect(line.slack_ts.length).toBeGreaterThan(0);
  });

  test("answering disables the buttons so it cannot be clicked twice", async () => {
    await ask();
    const q = rig.daemon.openQuestions()[0]!;
    const blocksTs = rig.tx.posts[1]!.ts;
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    const updated = rig.tx.posts.find((p) => p.ts === blocksTs)!;
    expect(updated.updates).toHaveLength(1);
    expect(JSON.stringify(updated.updates[0])).toContain("A");
    // second click on a settled question is ignored, not double-written
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "B") });
    expect(rig.inbox("alpha")).toHaveLength(1);
  });

  test("yes/no", async () => {
    await ask({ question_id: "qy", qtype: "yesno", options: [] });
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("qy", "yes") });
    expect(rig.inbox("alpha")[0]).toMatchObject({ question_id: "qy", choice: "yes" });
  });

  test("dropdown (static_select)", async () => {
    await ask({ question_id: "qs", qtype: "select", options: ["one", "two"] });
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("qs", "two") });
    expect(rig.inbox("alpha")[0]).toMatchObject({ question_id: "qs", choice: "two" });
  });

  test("multiselect settles only on Submit, and carries every choice", async () => {
    await ask({ question_id: "qm", qtype: "multiselect", options: ["a", "b", "c"] });
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.selectMulti({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_MULTI, selected: ["a", "c"] });
    expect(rig.inbox("alpha")).toHaveLength(0); // selecting is not answering
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_SUBMIT, value: encodeValue("qm", "submit") });
    const [line] = rig.inbox("alpha");
    expect(line.choices).toEqual(["a", "c"]);
    expect(line.choice).toBeUndefined();
  });

  test("submitting an empty multiselect nudges instead of settling", async () => {
    await ask({ question_id: "qm2", qtype: "multiselect", options: ["a"] });
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_SUBMIT, value: encodeValue("qm2", "submit") });
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.openQuestions()).toHaveLength(1);
    expect(rig.tx.thread(q.thread_ts).at(-1)!.text).toMatch(/select/i);
  });

  test("free text: a reply in the question thread IS the answer", async () => {
    await ask({ question_id: "qt", qtype: "text", options: [] });
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.say({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, text: "use the blue one" });
    const [line] = rig.inbox("alpha");
    expect(line).toMatchObject({ kind: "answer", question_id: "qt", text: "use the blue one", via: "slack" });
    expect(rig.daemon.openQuestions()).toHaveLength(0);
  });

  test("a thread reply on a BUTTON question is chat, not an answer", async () => {
    await ask({ question_id: "qb2" });
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.say({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, text: "why do you ask?" });
    const [line] = rig.inbox("alpha");
    expect(line.kind).toBe("message");
    expect(line.question_id).toBe("qb2");
    expect(rig.daemon.openQuestions()).toHaveLength(1);
  });

  test("the posted question states its timeout and default, so nothing is implicit", async () => {
    await ask({ question_id: "qd", timeout_ms: 1_800_000, default: "B", on_timeout: "default" });
    expect(rig.tx.posts[0]!.text).toMatch(/30m/);
    expect(rig.tx.posts[0]!.text).toMatch(/B/);
  });

  test("--urgent mentions the owner on the question itself", async () => {
    await ask({ question_id: "qu", urgent: true });
    expect(rig.tx.posts[0]!.text).toContain(`<@${OWNER}>`);
  });
});
