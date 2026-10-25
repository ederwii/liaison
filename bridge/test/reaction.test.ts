import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { eventToInboundReaction } from "../src/socket-transport.ts";
import { channelId, makeRig, OWNER, INTRUDER, type Rig } from "./harness.ts";

// Inbound reactions: an allowlisted person reacts on a message and the bridge
// records it in the project's inbox. Intake only — the session decides what an
// emoji means.

describe("eventToInboundReaction (pure mapper, same style as eventToInboundMessage)", () => {
  test("maps a reaction_added on a message item, keeping the emoji", () => {
    const r = eventToInboundReaction(
      { type: "reaction_added", user: "U1", reaction: "eyes", event_ts: "200.1",
        item: { type: "message", channel: "C1", ts: "100.1" } },
      "C1",
    );
    expect(r).toEqual({ type: "reaction_added", channel: "C1", user: "U1", emoji: "eyes", itemTs: "100.1", eventTs: "200.1" });
  });

  test("maps reaction_removed the same way", () => {
    const r = eventToInboundReaction(
      { type: "reaction_removed", user: "U1", reaction: "eyes", event_ts: "200.2",
        item: { type: "message", channel: "C1", ts: "100.1" } },
      "C1",
    );
    expect(r?.type).toBe("reaction_removed");
  });

  test("ignores reactions on non-message items (e.g. a file)", () => {
    expect(eventToInboundReaction(
      { type: "reaction_added", user: "U1", reaction: "eyes", item: { type: "file", channel: "C1", ts: "1" } }, "C1",
    )).toBeUndefined();
  });

  test("drops the bot's own reaction (the ✅ ack echoing back)", () => {
    const ev = { type: "reaction_added", user: "U_BOT", reaction: "white_check_mark", event_ts: "1.2",
      item: { type: "message", channel: "C1", ts: "1.1" } };
    expect(eventToInboundReaction(ev, "C1", "U_BOT")).toBeUndefined();
    expect(eventToInboundReaction(ev, "C1", "U_OTHER")).toMatchObject({ user: "U_BOT", emoji: "white_check_mark" });
  });

  test("ignores an event with no emoji", () => {
    expect(eventToInboundReaction(
      { type: "reaction_added", user: "U1", item: { type: "message", channel: "C1", ts: "1" } }, "C1",
    )).toBeUndefined();
  });

  test("drops unrelated event types", () => {
    expect(eventToInboundReaction({ type: "message", user: "U1" }, "C1")).toBeUndefined();
  });
});

describe("daemon: inbound reaction -> inbox 'reaction' line", () => {
  let rig: Rig;
  beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); await rig.daemon.ensureAllChannels(); });
  afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

  test("the owner's reaction fetches the message text and writes kind:reaction, action:added", async () => {
    const channel = channelId(rig, "alpha");
    rig.tx.messagesByTs.set(`${channel}:100.1`, "ship the thing, it worked");
    await rig.tx.emit({
      type: "reaction_added", channel, user: OWNER, emoji: "tada", itemTs: "100.1", eventTs: "200.1",
    });
    const reactionLines = rig.inbox("alpha").filter((l) => l.kind === "reaction");
    expect(reactionLines).toHaveLength(1);
    expect(reactionLines[0]).toMatchObject({
      kind: "reaction", action: "added", reactor: OWNER, emoji: "tada", role: "owner",
      channel, slack_ts: "100.1", text: "ship the thing, it worked", event_ts: "200.1",
    });
  });

  test("reaction_removed writes action:removed", async () => {
    const channel = channelId(rig, "alpha");
    rig.tx.messagesByTs.set(`${channel}:100.1`, "text");
    await rig.tx.emit({ type: "reaction_removed", channel, user: OWNER, emoji: "tada", itemTs: "100.1", eventTs: "200.2" });
    const lines = rig.inbox("alpha").filter((l) => l.kind === "reaction");
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe("removed");
  });

  test("someone other than the allowlisted owner never produces a reaction line", async () => {
    const channel = channelId(rig, "alpha");
    rig.tx.messagesByTs.set(`${channel}:100.1`, "text");
    await rig.tx.emit({ type: "reaction_added", channel, user: INTRUDER, emoji: "tada", itemTs: "100.1", eventTs: "9" });
    expect(rig.inbox("alpha").filter((l) => l.kind === "reaction")).toHaveLength(0);
  });

  test("a transport without fetchMessageText still writes the line, text empty", async () => {
    const channel = channelId(rig, "alpha");
    (rig.tx as any).fetchMessageText = undefined;
    await rig.tx.emit({ type: "reaction_added", channel, user: OWNER, emoji: "tada", itemTs: "999", eventTs: "1" });
    const lines = rig.inbox("alpha").filter((l) => l.kind === "reaction");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("");
  });
});
