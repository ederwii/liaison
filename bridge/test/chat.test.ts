import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";

let rig: Rig;
beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

async function openChannels() {
  rig.push("alpha", { kind: "say", text: "boot" });
  rig.push("beta", { kind: "say", text: "boot" });
  await rig.daemon.pump();
}

describe("§4.4 bidirectional chat", () => {
  test("a free message in a project channel becomes an inbox message line", async () => {
    await openChannels();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "how is it going?" });
    const [line] = rig.inbox("alpha");
    expect(line).toMatchObject({ kind: "message", from: OWNER, text: "how is it going?", channel: channelId(rig, "alpha") });
    expect(typeof line.slack_ts).toBe("string");
  });

  test("it lands in the RIGHT project's inbox and nowhere else", async () => {
    await openChannels();
    await rig.tx.say({ channel: channelId(rig, "beta"), user: OWNER, text: "only beta" });
    expect(rig.inbox("beta")).toHaveLength(1);
    expect(rig.inbox("alpha")).toHaveLength(0);
  });

  test("the session answers back with a say — round trip, console-style", async () => {
    await openChannels();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "status?" });
    expect(rig.inbox("alpha")[0].text).toBe("status?");
    rig.push("alpha", { kind: "say", text: "3 tests left" });
    await rig.daemon.pump();
    expect(rig.tx.posts.at(-1)!.text).toContain("3 tests left");
  });

  test("empty / whitespace-only messages are dropped", async () => {
    await openChannels();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "   " });
    expect(rig.inbox("alpha")).toHaveLength(0);
  });
});
