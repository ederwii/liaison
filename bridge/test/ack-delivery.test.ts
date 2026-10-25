// ---------------------------------------------------------------------------
// ack-delivery.test.ts — daemon-level delivery of the outbox `reaction` kind,
// the read-receipt ✅ that bin/slack-ack queues. Drives the daemon like every
// other test here: FakeTransport, rig.push() straight to the outbox,
// rig.daemon.pump().
// ---------------------------------------------------------------------------
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { channelId, makeRig, type Rig } from "./harness.ts";

let rig: Rig;
beforeEach(async () => {
  rig = makeRig();
  await rig.daemon.start();
  rig.push("alpha", { kind: "say", text: "boot" }); // ensure the channel exists
  await rig.daemon.pump();
});
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

describe("outbox kind reaction — the read-receipt ✅", () => {
  test("delivers reactions.add-shaped params to the transport", async () => {
    const ch = channelId(rig, "alpha");
    rig.push("alpha", { kind: "reaction", channel: ch, slack_ts: "1700000111.000100", name: "white_check_mark" } as never);
    await rig.daemon.pump();
    expect(rig.tx.reactions).toEqual([{ channel: ch, timestamp: "1700000111.000100", name: "white_check_mark" }]);
  });

  test("a transport without addReaction fails into the project's own inbox as an error, never a crash", async () => {
    // addReaction is a class method, so an own-property delete is a no-op — assign over it.
    (rig.tx as unknown as { addReaction?: unknown }).addReaction = undefined;
    const ch = channelId(rig, "alpha");
    rig.push("alpha", { kind: "reaction", channel: ch, slack_ts: "1700000222.000100", name: "white_check_mark" } as never);
    await expect(rig.daemon.pump()).resolves.toBeUndefined();
    const [line] = rig.inbox("alpha").filter((l) => l.kind === "error");
    expect(line.reason).toMatch(/reactions not supported/);
  });

  test("a transient transport failure is retried on the next pump — never fatal for the daemon", async () => {
    const ch = channelId(rig, "alpha");
    rig.tx.failReactions = 1;
    rig.push("alpha", { kind: "reaction", channel: ch, slack_ts: "1700000333.000100", name: "white_check_mark" } as never);
    await expect(rig.daemon.pump()).resolves.toBeUndefined(); // first attempt throws internally, pump() itself never does
    expect(rig.tx.reactions).toHaveLength(0); // not yet delivered — this pump's attempt failed
    expect(rig.inbox("alpha").filter((l) => l.kind === "error")).toHaveLength(0); // not given up on yet (< 3 attempts)
    await rig.daemon.pump(); // retried: succeeds this time
    expect(rig.tx.reactions).toHaveLength(1);
  });
});
