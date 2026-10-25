import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";
import { Daemon } from "../src/daemon.ts";
import { ACTION_CHOICE, encodeValue } from "../src/blocks.ts";

let rig: Rig;
beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop().catch(() => {}); rig.cleanup(); });

function revive(r: Rig): Daemon {
  return new Daemon({
    transport: r.tx,
    config: { root: r.root, allowedUserIds: [OWNER], projects: [
      { slug: "alpha", channel: "liaison-alpha", paths: [] },
      { slug: "beta", channel: "liaison-beta", paths: [] },
    ], dryRun: false },
    now: () => r.clock.t,
  });
}

describe("§4.6 the queue IS the file — delivery survives a dead session", () => {
  test("an answer is written even though nobody is reading", async () => {
    rig.push("alpha", { kind: "ask", question_id: "q1", text: "?", qtype: "buttons", options: ["A"] } as any);
    await rig.daemon.pump();
    const q = rig.daemon.openQuestions()[0]!;
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    const raw = readFileSync(rig.inboxPath("alpha"), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toMatchObject({ kind: "answer", choice: "A" });
  });

  test("a NEW daemon reads the old question state and can still settle it", async () => {
    rig.push("alpha", { kind: "ask", question_id: "q1", text: "?", qtype: "buttons", options: ["A"] } as any);
    await rig.daemon.pump();
    const q = rig.daemon.openQuestions()[0]!;
    await rig.daemon.stop();

    const second = revive(rig);
    await second.start();
    expect(second.openQuestions().map((x) => x.question_id)).toEqual(["q1"]);
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    expect(rig.inbox("alpha")[0]).toMatchObject({ question_id: "q1", choice: "A" });
    await second.stop();
  });

  test("an outbox cursor is durable: a restarted daemon does not re-post old events", async () => {
    rig.push("alpha", { kind: "say", text: "one" });
    await rig.daemon.pump();
    expect(rig.tx.posts).toHaveLength(1);
    await rig.daemon.stop();

    const second = revive(rig);
    await second.start();
    await second.pump();
    expect(rig.tx.posts).toHaveLength(1);   // no duplicate
    rig.push("alpha", { kind: "say", text: "two" });
    await second.pump();
    expect(rig.tx.posts).toHaveLength(2);
    await second.stop();
  });

  test("an outbox event written while the daemon was DOWN is delivered on next boot", async () => {
    await rig.daemon.stop();
    rig.push("alpha", { kind: "say", text: "written while offline" });
    const second = revive(rig);
    await second.start();
    await second.pump();
    expect(rig.tx.posts.at(-1)!.text).toContain("written while offline");
    await second.stop();
  });

  test("a failed post is retried, not skipped, and never double-posted", async () => {
    rig.tx.failPosts = 1;
    rig.push("alpha", { kind: "say", text: "flaky" });
    await rig.daemon.pump();
    expect(rig.tx.posts).toHaveLength(0);
    expect(rig.daemon.logs.some((l) => l.level === "error")).toBe(true);
    await rig.daemon.pump();
    expect(rig.tx.posts).toHaveLength(1);
    await rig.daemon.pump();
    expect(rig.tx.posts).toHaveLength(1);
  });

  test("a permanently failing event gives up after 3 tries and reports to the inbox", async () => {
    rig.tx.failPosts = 99;
    rig.push("alpha", { kind: "say", text: "doomed" });
    for (let i = 0; i < 4; i++) await rig.daemon.pump();
    const errs = rig.inbox("alpha").filter((l) => l.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].reason).toMatch(/delivery/i);
    // and it does not block the next event
    rig.tx.failPosts = 0;
    rig.push("alpha", { kind: "say", text: "after" });
    await rig.daemon.pump();
    expect(rig.tx.posts.at(-1)!.text).toContain("after");
  });

  test("the inbox is append-only across restarts — nothing is truncated", async () => {
    rig.push("alpha", { kind: "say", text: "boot" });
    await rig.daemon.pump();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "first" });
    await rig.daemon.stop();
    const second = revive(rig);
    await second.start();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "second" });
    expect(rig.inbox("alpha").map((l) => l.text)).toEqual(["first", "second"]);
    await second.stop();
  });
});
