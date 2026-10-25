import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";

let rig: Rig;
beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

describe("§4.1 channel per project, auto-created", () => {
  test("first say for a project creates #liaison-<project> and posts there", async () => {
    rig.push("alpha", { kind: "say", text: "hello" });
    await rig.daemon.pump();
    expect(rig.tx.channels.has("liaison-alpha")).toBe(true);
    expect(rig.tx.posts).toHaveLength(1);
    expect(rig.tx.posts[0]!.channel).toBe(channelId(rig, "alpha"));
    expect(rig.tx.posts[0]!.text).toContain("hello");
  });

  // F2 REGRESSION. A bot-created channel contains ONLY the bot.
  // Live, the daemon created a channel, posted a question into it a second
  // later, and the owner was not a member until they found it and joined by
  // hand minutes later — a question addressed to an empty room. The allowlist must be invited the moment a channel is born.
  test("creating a channel invites the allowlist into it", async () => {
    rig.push("alpha", { kind: "say", text: "hello" });
    await rig.daemon.pump();
    expect(rig.tx.invites.get(channelId(rig, "alpha"))).toEqual([OWNER]);
  });

  test("every allowlisted user is invited, not just the first", async () => {
    const r = makeRig({ allowed: [OWNER, "U_SECOND", "U_THIRD"] });
    await r.daemon.start();
    r.push("alpha", { kind: "say", text: "hello" });
    await r.daemon.pump();
    expect(r.tx.invites.get(channelId(r, "alpha"))).toEqual([OWNER, "U_SECOND", "U_THIRD"]);
    await r.daemon.stop(); r.cleanup();
  });

  test("an EXISTING channel is not re-invited on every message", async () => {
    rig.tx.seedChannel("liaison-alpha", "C_SEEDED");
    rig.push("alpha", { kind: "say", text: "one" });
    rig.push("alpha", { kind: "say", text: "two" });
    await rig.daemon.pump();
    expect(rig.tx.invites.size).toBe(0);
  });

  test("an empty allowlist invites nobody rather than throwing", async () => {
    const r = makeRig({ allowed: [] });
    await r.daemon.start();
    r.push("alpha", { kind: "say", text: "hello" });
    await r.daemon.pump();
    expect(r.tx.invites.size).toBe(0);
    expect(r.tx.posts).toHaveLength(1);
    await r.daemon.stop(); r.cleanup();
  });

  test("the channel is created once, not once per message", async () => {
    rig.push("alpha", { kind: "say", text: "one" });
    rig.push("alpha", { kind: "say", text: "two" });
    await rig.daemon.pump();
    expect(rig.tx.posts).toHaveLength(2);
    expect(rig.tx.channels.size).toBe(1);
  });

  test("§4.8 two projects go to two different channels in one daemon", async () => {
    rig.push("alpha", { kind: "say", text: "A" });
    rig.push("beta", { kind: "say", text: "S" });
    await rig.daemon.pump();
    const byText = Object.fromEntries(rig.tx.posts.map((p) => [p.text.replace(/\s/g, ""), p.channel]));
    expect(byText["A"]).toBe(channelId(rig, "alpha"));
    expect(byText["S"]).toBe(channelId(rig, "beta"));
    expect(byText["A"]).not.toBe(byText["S"]);
  });

  test("§4.7 default say carries no @mention; --urgent does", async () => {
    rig.push("alpha", { kind: "say", text: "quiet" });
    rig.push("alpha", { kind: "say", text: "loud", urgent: true });
    await rig.daemon.pump();
    expect(rig.tx.posts[0]!.text).not.toContain(`<@${OWNER}>`);
    expect(rig.tx.posts[1]!.text).toContain(`<@${OWNER}>`);
  });

  test("a say with a question_id lands in that question's thread", async () => {
    const ask = rig.push("alpha", { kind: "ask", question_id: "q_thread", text: "pick", qtype: "buttons", options: ["A"] });
    await rig.daemon.pump();
    const parentTs = rig.tx.posts[0]!.ts;
    rig.push("alpha", { kind: "say", text: "extra context", question_id: (ask as any).question_id });
    await rig.daemon.pump();
    const last = rig.tx.posts.at(-1)!;
    expect(last.threadTs).toBe(parentTs);
    expect(last.text).toContain("extra context");
  });

  test("an inbound event on a channel this daemon does not own is ignored", async () => {
    await rig.tx.say({ channel: "C_SOMEONE_ELSE", user: OWNER, text: "hello" });
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.inbox("beta")).toHaveLength(0);
    expect(rig.daemon.logs.some((l) => l.msg === "unknown_channel")).toBe(true);
  });

  test("the daemon never echoes its own posts back into the inbox", async () => {
    rig.push("alpha", { kind: "say", text: "hello" });
    await rig.daemon.pump();
    await rig.tx.emit({ type: "message", channel: channelId(rig, "alpha"), user: "B_BOT", text: "hello", ts: "1.1", isBot: true });
    expect(rig.inbox("alpha")).toHaveLength(0);
  });
});
