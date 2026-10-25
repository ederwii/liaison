import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";
import { Daemon } from "../src/daemon.ts";

let rig: Rig;
beforeEach(async () => {
  rig = makeRig();
  await rig.daemon.start();
  rig.push("alpha", { kind: "say", text: "boot" });
  rig.push("beta", { kind: "say", text: "boot" });
  await rig.daemon.pump();
});
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

const pause = () => rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "pause" });
const resume = () => rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "resume" });

describe("§4.7 pause / resume kill switch, per channel", () => {
  test("`pause` is consumed as a command, not routed to the session", async () => {
    await pause();
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.isPaused("alpha")).toBe(true);
  });

  test("while paused, say is dropped (noise control) and logged", async () => {
    await pause();
    const before = rig.tx.posts.length;
    rig.push("alpha", { kind: "say", text: "noise" });
    await rig.daemon.pump();
    expect(rig.tx.posts).toHaveLength(before);
    expect(rig.daemon.logs.some((l) => l.msg === "suppressed_while_paused")).toBe(true);
  });

  test("while paused, an ask FAILS FAST instead of stalling the session forever", async () => {
    await pause();
    rig.push("alpha", { kind: "ask", question_id: "q1", text: "?", qtype: "yesno", options: [] } as any);
    await rig.daemon.pump();
    const [line] = rig.inbox("alpha");
    expect(line).toMatchObject({ kind: "blocked", question_id: "q1", reason: "channel_paused" });
    expect(rig.daemon.openQuestions()).toHaveLength(0);
  });

  test("pausing one project does not pause the others", async () => {
    await pause();
    rig.push("beta", { kind: "say", text: "still talking" });
    await rig.daemon.pump();
    expect(rig.tx.posts.at(-1)!.text).toContain("still talking");
    expect(rig.daemon.isPaused("beta")).toBe(false);
  });

  test("`resume` re-opens the channel and reports how much was suppressed", async () => {
    await pause();
    rig.push("alpha", { kind: "say", text: "n1" });
    rig.push("alpha", { kind: "say", text: "n2" });
    await rig.daemon.pump();
    await resume();
    expect(rig.daemon.isPaused("alpha")).toBe(false);
    expect(rig.tx.posts.at(-1)!.text).toMatch(/2/);
    rig.push("alpha", { kind: "say", text: "back" });
    await rig.daemon.pump();
    expect(rig.tx.posts.at(-1)!.text).toContain("back");
  });

  test("pause from a non-allowlisted user does nothing", async () => {
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: "U_RANDO", text: "pause" });
    expect(rig.daemon.isPaused("alpha")).toBe(false);
  });

  test("the command matches only an exact bare word, so real chat is unaffected", async () => {
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "can we pause the refactor?" });
    expect(rig.daemon.isPaused("alpha")).toBe(false);
    expect(rig.inbox("alpha")).toHaveLength(1);
  });

  test("paused state survives a daemon restart", async () => {
    await pause();
    await rig.daemon.stop();
    const revived = makeRigLike(rig);
    await revived.start();
    expect(revived.isPaused("alpha")).toBe(true);
  });
});

function makeRigLike(r: Rig) {
  return new Daemon({
    transport: r.tx,
    config: { root: r.root, allowedUserIds: [OWNER], projects: [
      { slug: "alpha", channel: "liaison-alpha", paths: [] },
      { slug: "beta", channel: "liaison-beta", paths: [] },
    ], dryRun: false },
    now: () => r.clock.t,
  });
}
