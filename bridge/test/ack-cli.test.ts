// ---------------------------------------------------------------------------
// ack-cli.test.ts — bin/slack-ack's logic: the outbox line shape it writes,
// and which inbox line `--last` picks. Also pins the CLI arg handling it
// relies on (parseArgs/bool/str — src/args.ts) for the flags this command
// introduces: a bare positional ts, --channel, --last, --help.
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { bool, parseArgs, str } from "../src/args.ts";
import { ACK_REACTION_NAME, buildAckReaction, isAckableOwnerLine, parseAckedFile, selectNewestUnacked } from "../src/ack.ts";
import type { AnswerLine, BlockedLine, ErrorLine, InboxLine, MessageLine } from "../src/types.ts";

// ----------------------------------------------------------- CLI arg handling

describe("slack-ack arg handling (src/args.ts, as bin/slack-ack calls it)", () => {
  test("a bare positional ts with no flags", () => {
    const p = parseArgs(["1700000111.000100"]);
    expect(p.positional).toEqual(["1700000111.000100"]);
    expect(bool(p, "last")).toBe(false);
    expect(str(p, "channel")).toBeUndefined();
  });

  test("ts plus --channel <id>", () => {
    const p = parseArgs(["1700000111.000100", "--channel", "C0123456"]);
    expect(p.positional).toEqual(["1700000111.000100"]);
    expect(str(p, "channel")).toBe("C0123456");
  });

  test("--last with no positional ts", () => {
    const p = parseArgs(["--last"]);
    expect(p.positional).toEqual([]);
    expect(bool(p, "last")).toBe(true);
  });

  test("--last is a boolean flag, not an eater of the next token", () => {
    const p = parseArgs(["--last", "--channel", "C0999"]);
    expect(bool(p, "last")).toBe(true);
    expect(str(p, "channel")).toBe("C0999");
  });

  test("--help short-circuits regardless of other flags", () => {
    const p = parseArgs(["--help"]);
    expect(p.flags["help"]).toBe(true);
  });

  test("neither a ts nor --last is the bad-usage case bin/slack-ack exits 2 for", () => {
    const p = parseArgs([]);
    expect(p.positional[0]).toBeUndefined();
    expect(bool(p, "last")).toBe(false);
  });
});

// --------------------------------------------------------- outbox line shape

describe("buildAckReaction — the outbox `reaction` line shape", () => {
  test("carries exactly channel, slack_ts, name, plus the standard id/ts/kind/project envelope", () => {
    const e = buildAckReaction("alpha", "C0123456", "1700000111.000100");
    expect(e.kind).toBe("reaction");
    expect(e.project).toBe("alpha");
    expect(e.channel).toBe("C0123456");
    expect(e.slack_ts).toBe("1700000111.000100");
    expect(e.name).toBe("white_check_mark");
    expect(e.name).toBe(ACK_REACTION_NAME);
    expect(typeof e.id).toBe("string");
    expect(e.id.startsWith("reaction_")).toBe(true);
    expect(() => new Date(e.ts).toISOString()).not.toThrow();
  });

  test("two calls never collide on id", () => {
    const a = buildAckReaction("alpha", "C1", "ts1");
    const b = buildAckReaction("alpha", "C1", "ts2");
    expect(a.id).not.toBe(b.id);
  });
});

// ------------------------------------------------------------ --last selection

const msg = (slack_ts: string, from = "U_OWNER"): MessageLine =>
  ({ ts: "2000-01-01T00:00:00.000Z", kind: "message", from, text: "hello", channel: "C1", slack_ts });

const answer = (slack_ts: string, from: string): AnswerLine =>
  ({
    ts: "2000-01-01T00:00:00.000Z", kind: "answer", question_id: "q_1", from, choice: "Ship",
    channel: "C1", slack_ts, answered_by: from, via: from === "system" ? "timeout-default" : "slack",
    executed_by: from, authority: from === "system" ? "system-default" : "owner-decision",
  });

const blocked: BlockedLine = { ts: "2000-01-01T00:00:00.000Z", kind: "blocked", question_id: "q_1", reason: "channel_paused", text: "paused" };
const error: ErrorLine = { ts: "2000-01-01T00:00:00.000Z", kind: "error", ref_id: "say_1", reason: "boom" };

describe("isAckableOwnerLine", () => {
  test("message lines are ackable", () => { expect(isAckableOwnerLine(msg("ts1"))).toBe(true); });
  test("a real (human) answer is ackable", () => { expect(isAckableOwnerLine(answer("ts1", "U_OWNER"))).toBe(true); });
  test("a timeout-default answer (from: system) is NOT ackable — nobody read anything", () => {
    expect(isAckableOwnerLine(answer("ts1", "system"))).toBe(false);
  });
  test("blocked and error lines are not ackable", () => {
    expect(isAckableOwnerLine(blocked)).toBe(false);
    expect(isAckableOwnerLine(error)).toBe(false);
  });
});

describe("selectNewestUnacked", () => {
  test("picks the newest ackable line when none are acked yet", () => {
    const lines: InboxLine[] = [msg("ts1"), msg("ts2"), msg("ts3")];
    expect(selectNewestUnacked(lines, new Set())?.slack_ts).toBe("ts3");
  });

  test("skips lines already in the acked set, even if they are the newest", () => {
    const lines: InboxLine[] = [msg("ts1"), msg("ts2"), msg("ts3")];
    expect(selectNewestUnacked(lines, new Set(["ts3"]))?.slack_ts).toBe("ts2");
  });

  test("returns undefined when every ackable line is already acked", () => {
    const lines: InboxLine[] = [msg("ts1"), msg("ts2")];
    expect(selectNewestUnacked(lines, new Set(["ts1", "ts2"]))).toBeUndefined();
  });

  test("skips blocked/error/timeout lines even when newest, in favour of an older ackable one", () => {
    const lines: InboxLine[] = [msg("ts1"), answer("ts2", "system"), blocked, error];
    expect(selectNewestUnacked(lines, new Set())?.slack_ts).toBe("ts1");
  });

  test("an empty inbox selects nothing", () => {
    expect(selectNewestUnacked([], new Set())).toBeUndefined();
  });
});

describe("parseAckedFile", () => {
  test("one ts per line, blank lines and trailing newline ignored", () => {
    expect(parseAckedFile("ts1\nts2\n\nts3\n")).toEqual(new Set(["ts1", "ts2", "ts3"]));
  });
  test("empty file -> empty set", () => {
    expect(parseAckedFile("")).toEqual(new Set());
  });
});
