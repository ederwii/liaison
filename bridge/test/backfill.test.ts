import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backfillOnBoot } from "../src/backfill.ts";
import type { InboundMessage } from "../src/transport.ts";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";

// Zombie-websocket incident: messages sent while the inbound
// socket was dead never reached any inbox. backfillOnBoot is the recovery —
// it must replay missed human messages through the exact daemon pipeline,
// skip anything already delivered, respect the allowlist, and persist its
// OWN cursor (never a consumer's `.cursor.<reader>` file).

let rig: Rig;
beforeEach(async () => {
  rig = makeRig();
  await rig.daemon.start();
  await rig.daemon.ensureAllChannels(); // populates channelToSlug — backfillOnBoot's worklist
});
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

/** Slack ts values are Unix seconds — keep them inside rig.clock's own clock, not epoch 0. */
function tsNear(rig: Rig, offsetSeconds: number): string {
  return String(rig.clock.t / 1000 - offsetSeconds);
}

function msg(rig: Rig, over: Partial<InboundMessage> & { channel: string }): InboundMessage {
  return { type: "message", user: OWNER, text: "missed while dead", threadTs: undefined, isBot: false, ts: tsNear(rig, 10), ...over };
}

/** Seed inbox.jsonl directly, as if a prior daemon run (pre-dating this feature) already wrote it. */
function seedInbox(rig: Rig, slug: string, slackTs: string): void {
  const line = { ts: new Date(rig.clock.t).toISOString(), kind: "message", from: OWNER, text: "already delivered", channel: channelId(rig, slug), slack_ts: slackTs };
  appendFileSync(rig.inboxPath(slug), `${JSON.stringify(line)}\n`);
}

describe("backfillOnBoot", () => {
  test("replays a missed message through the real inbox pipeline", async () => {
    const chan = channelId(rig, "alpha");
    // A baseline already-delivered message establishes "newest in inbox" —
    // without this, a brand-new (empty-inbox) project's cold start is "now",
    // by design (see the cold-start test below), and nothing before "now"
    // would replay.
    seedInbox(rig, "alpha", tsNear(rig, 20));
    const ts = tsNear(rig, 10);
    rig.tx.historyByChannel.set(chan, [msg(rig, { channel: chan, ts })]);

    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });

    const lines = rig.inbox("alpha");
    expect(lines).toHaveLength(2);
    expect(lines[1].kind).toBe("message");
    expect(lines[1].slack_ts).toBe(ts);
    expect(lines[1].from).toBe(OWNER);
  });

  test("cold start (no .bridge-cursor): does not replay anything older than the newest inbox slack_ts", async () => {
    const chan = channelId(rig, "alpha");
    const baseline = tsNear(rig, 50);
    seedInbox(rig, "alpha", baseline);
    const older = tsNear(rig, 60); // predates baseline — must NOT replay
    const newer = tsNear(rig, 5);  // postdates baseline — SHOULD replay
    rig.tx.historyByChannel.set(chan, [
      msg(rig, { channel: chan, ts: older, text: "ancient, already accounted for" }),
      msg(rig, { channel: chan, ts: newer, text: "missed after the baseline" }),
    ]);

    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });

    const lines = rig.inbox("alpha");
    const tsSet = new Set(lines.map((l: { slack_ts: string }) => l.slack_ts));
    expect(tsSet.has(older)).toBe(false);
    expect(tsSet.has(newer)).toBe(true);
    expect(lines).toHaveLength(2); // baseline + the one newer message
  });

  test("cold start on a brand-new (empty-inbox) project backfills nothing — floor is \"now\", not 24h", async () => {
    const chan = channelId(rig, "alpha");
    // No seedInbox call: this project has never delivered anything.
    rig.tx.historyByChannel.set(chan, [msg(rig, { channel: chan, ts: tsNear(rig, 3600) })]); // 1h "old"
    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });
    expect(rig.inbox("alpha")).toHaveLength(0);
  });

  test("does not re-deliver a message already in inbox.jsonl (dedupe by slack_ts)", async () => {
    const chan = channelId(rig, "alpha");
    seedInbox(rig, "alpha", tsNear(rig, 25)); // baseline, so the message below is "newer" and gets fetched
    const ts = tsNear(rig, 20);
    // Simulate: this one already arrived live and was written once.
    rig.tx.historyByChannel.set(chan, [msg(rig, { channel: chan, ts })]);
    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });
    expect(rig.inbox("alpha")).toHaveLength(2); // baseline + the replayed one

    // Re-run backfill with the SAME history (e.g. daemon restarted again
    // before Slack's history window moved) — must not duplicate the line.
    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });
    expect(rig.inbox("alpha")).toHaveLength(2);
  });

  test("never backfills for a user off the allowlist", async () => {
    const chan = channelId(rig, "alpha");
    seedInbox(rig, "alpha", tsNear(rig, 35)); // baseline older than the message below
    rig.tx.historyByChannel.set(chan, [msg(rig, { channel: chan, ts: tsNear(rig, 30), user: "U_RANDO" })]);
    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });
    expect(rig.inbox("alpha")).toHaveLength(1); // only the baseline — the not-allowlisted one was dropped
  });

  test("persists its OWN cursor file, separate from a consumer's .cursor.<reader>", async () => {
    const chan = channelId(rig, "alpha");
    seedInbox(rig, "alpha", tsNear(rig, 45)); // baseline older than the message below
    const ts = tsNear(rig, 40);
    rig.tx.historyByChannel.set(chan, [msg(rig, { channel: chan, ts })]);
    await backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t });

    const cursorPath = join(rig.root, "alpha", ".bridge-cursor");
    const persisted = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(persisted.lastTs).toBe(ts);
  });

  test("a provider with no fetchHistory is a no-op, not a crash", async () => {
    const original = rig.tx.fetchHistory;
    // @ts-expect-error — simulating a transport that never implemented it (a transport with no history API)
    rig.tx.fetchHistory = undefined;
    try {
      await expect(
        backfillOnBoot({ daemon: rig.daemon, transport: rig.tx, root: rig.root, log: () => {}, now: () => rig.clock.t }),
      ).resolves.toBeUndefined();
      expect(rig.inbox("alpha")).toHaveLength(0);
    } finally { rig.tx.fetchHistory = original; }
  });

  test("a fetchHistory failure for one project does not block another", async () => {
    const good = channelId(rig, "beta");
    seedInbox(rig, "beta", tsNear(rig, 55)); // baseline older than the message below
    rig.tx.historyByChannel.set(good, [msg(rig, { channel: good, ts: tsNear(rig, 50) })]);
    const originalFetch = rig.tx.fetchHistory!.bind(rig.tx);
    rig.tx.fetchHistory = async (channel: string, oldest: string) => {
      if (channel === channelId(rig, "alpha")) throw new Error("boom");
      return originalFetch(channel, oldest);
    };
    const warnings: string[] = [];
    await backfillOnBoot({
      daemon: rig.daemon, transport: rig.tx, root: rig.root,
      log: (r) => { if (r.level === "warn") warnings.push(r.msg); }, now: () => rig.clock.t,
    });
    expect(warnings).toContain("backfill_fetch_failed");
    expect(rig.inbox("beta")).toHaveLength(2); // baseline + the replayed one
  });
});
