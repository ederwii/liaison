import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { channelId, INTRUDER, makeRig, OWNER, type Rig } from "./harness.ts";
import { ACTION_CHOICE, encodeValue } from "../src/blocks.ts";

let rig: Rig;
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

async function boot(allowed?: string[]) {
  rig = makeRig(allowed === undefined ? {} : { allowed });
  await rig.daemon.start();
  rig.push("alpha", { kind: "say", text: "boot" });
  await rig.daemon.pump();
}

describe("§5 only the owner is obeyed", () => {
  test("a message from a non-allowlisted user is ignored and logged", async () => {
    await boot();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: INTRUDER, text: "deploy to prod" });
    expect(rig.inbox("alpha")).toHaveLength(0);
    const log = rig.daemon.logs.find((l) => l.msg === "not_allowlisted");
    expect(log).toBeDefined();
    expect(log!.fields).toMatchObject({ user: INTRUDER });
  });

  test("a BUTTON CLICK from a non-allowlisted user does not answer the question", async () => {
    await boot();
    rig.push("alpha", { kind: "ask", question_id: "q1", text: "?", qtype: "buttons", options: ["A", "B"] } as any);
    await rig.daemon.pump();
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.clickButton({ channel: q.channel, user: INTRUDER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.openQuestions()).toHaveLength(1);
    expect(rig.daemon.logs.some((l) => l.msg === "not_allowlisted")).toBe(true);
  });

  test("the daemon stays silent — it does not tell the intruder anything", async () => {
    await boot();
    const before = rig.tx.posts.length;
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: INTRUDER, text: "hello?" });
    expect(rig.tx.posts).toHaveLength(before);
  });

  test("an empty allowlist fails CLOSED — nobody is obeyed", async () => {
    await boot([]);
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "hello" });
    expect(rig.inbox("alpha")).toHaveLength(0);
    expect(rig.daemon.logs.some((l) => l.msg === "not_allowlisted")).toBe(true);
  });

  test("a second allowlisted id also works", async () => {
    await boot([OWNER, "U_SECOND"]);
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: "U_SECOND", text: "hello" });
    expect(rig.inbox("alpha")).toHaveLength(1);
  });

  test("never logs anything token-shaped", async () => {
    await boot();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: INTRUDER, text: "xoxb-1234-secret" });
    const dump = JSON.stringify(rig.daemon.logs);
    expect(dump).not.toContain("xoxb-");
    expect(dump).not.toContain("xapp-");
  });
});
