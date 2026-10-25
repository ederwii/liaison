// ---------------------------------------------------------------------------
// THE ACK. When a question settles, the owner gets exactly one confirmation
// that quotes back what the bridge understood and says it reached the session.
//
// Why it is not decoration: the ack is the owner's only chance to catch a
// misunderstood answer at the moment it happens, rather than an hour later
// when the work came out wrong. It also answers the question every human asks
// a bot — "did that go through?" — without them having to ask it.
//
// Exactly ONE, per settle. Two confirmations for one answer is noise, and noise
// is what makes people stop reading the channel.
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeRig, OWNER, type Rig, channelId } from "./harness.ts";
import { ACTION_CHOICE, ACTION_MULTI, ACTION_SUBMIT, choiceActionId, encodeValue } from "../src/blocks.ts";

const QTYPES = ["buttons", "yesno", "select", "multiselect", "text"] as const;

describe("Slack: the settled-blocks edit IS the ack", () => {
  let rig: Rig;
  beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
  afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

  const ask = async (qtype: (typeof QTYPES)[number]) => {
    rig.push("alpha", {
      kind: "ask", text: "Ship?", qtype,
      options: qtype === "yesno" || qtype === "text" ? [] : ["Ship", "Hold"],
      timeout_ms: null, default: null, on_timeout: "escalate",
    } as never);
    await rig.daemon.pump();
    const q = rig.daemon.openQuestions().at(-1)!;
    return q;
  };

  for (const qtype of QTYPES) {
    test(`${qtype}: exactly one ack, quoting the value and the answerer`, async () => {
      const q = await ask(qtype);
      const ch = channelId(rig, "alpha");
      const postsBefore = rig.tx.posts.length;

      if (qtype === "text") {
        await rig.tx.say({ channel: ch, user: OWNER, text: "the blue one", threadTs: q.thread_ts });
      } else if (qtype === "multiselect") {
        await rig.tx.emit({
          type: "action", channel: ch, user: OWNER, ts: "1.1", threadTs: q.thread_ts,
          actionId: ACTION_SUBMIT, value: encodeValue(q.question_id, "submit"),
          blockState: { [ACTION_MULTI]: ["Ship"] },
        });
      } else {
        const value = encodeValue(q.question_id, qtype === "yesno" ? "yes" : "Ship");
        await rig.tx.clickButton({
          channel: ch, user: OWNER, threadTs: q.thread_ts,
          actionId: qtype === "select" ? ACTION_CHOICE : choiceActionId(0), value,
        });
      }

      const acks = rig.tx.posts.flatMap((p) => p.updates).filter((u) => u.text.includes("Received"));
      expect(acks).toHaveLength(1);
      expect(acks[0]!.text).toContain(qtype === "text" ? "the blue one" : (qtype === "yesno" ? "yes" : "Ship"));
      expect(acks[0]!.text).toContain("delivered to the session");
      // and NOT a second, new message on top of the edit
      expect(rig.tx.posts.length).toBe(postsBefore);
    });
  }
});

describe("the ack never costs an answer", () => {
  let rig: Rig;
  beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
  afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

  test("the inbox line is written even if editing the blocks into the ack fails", async () => {
    rig.push("alpha", {
      kind: "ask", text: "Ship?", qtype: "buttons", options: ["Ship", "Hold"],
      timeout_ms: null, default: null, on_timeout: "escalate",
    } as never);
    await rig.daemon.pump();
    const q = rig.daemon.openQuestions().at(-1)!;
    rig.tx.updateMessage = async () => { throw new Error("HTTP 500"); };
    await rig.tx.clickButton({
      channel: channelId(rig, "alpha"), user: OWNER, threadTs: q.thread_ts,
      actionId: choiceActionId(0), value: encodeValue(q.question_id, "Ship"),
    });

    expect(rig.inbox("alpha").find((l) => l.kind === "answer")).toMatchObject({ choice: "Ship" });
    expect(rig.daemon.logs.some((l) => l.msg === "settle_ack_failed")).toBe(true);
  });
});
