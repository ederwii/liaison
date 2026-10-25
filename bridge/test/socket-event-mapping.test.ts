import { describe, expect, test } from "bun:test";
import { eventToInboundMessage } from "../src/socket-transport.ts";

// This mapper is shared by the live events_api dispatch path and the
// boot-time fetchHistory backfill path — a backfilled message must be held
// to the exact same human/bot and subtype rules a live one is.

describe("eventToInboundMessage", () => {
  test("maps a plain human message", () => {
    const msg = eventToInboundMessage(
      { type: "message", channel: "C1", user: "U1", text: "hi", ts: "100.1" }, "BOT", "C1",
    );
    expect(msg).toEqual({ type: "message", channel: "C1", user: "U1", text: "hi", ts: "100.1", threadTs: undefined, isBot: false });
  });

  test("flags the bot's own message via bot_id", () => {
    const msg = eventToInboundMessage({ type: "message", channel: "C1", user: "U1", text: "hi", ts: "1", bot_id: "B1" }, "BOT", "C1");
    expect(msg?.isBot).toBe(true);
  });

  test("flags the bot's own message via matching user id", () => {
    const msg = eventToInboundMessage({ type: "message", channel: "C1", user: "BOT", text: "hi", ts: "1" }, "BOT", "C1");
    expect(msg?.isBot).toBe(true);
  });

  test("drops non-message event types", () => {
    expect(eventToInboundMessage({ type: "reaction_added" }, "BOT", "C1")).toBeUndefined();
  });

  test("drops edit/join/leave subtypes", () => {
    expect(eventToInboundMessage({ type: "message", subtype: "message_changed", ts: "1" }, "BOT", "C1")).toBeUndefined();
    expect(eventToInboundMessage({ type: "message", subtype: "channel_join", ts: "1" }, "BOT", "C1")).toBeUndefined();
  });

  test("keeps thread_broadcast and file_share subtypes", () => {
    expect(eventToInboundMessage({ type: "message", subtype: "thread_broadcast", ts: "1", user: "U1" }, "BOT", "C1")).toBeDefined();
    expect(eventToInboundMessage({ type: "message", subtype: "file_share", ts: "1", user: "U1" }, "BOT", "C1")).toBeDefined();
  });

  test("carries thread_ts through as threadTs", () => {
    const msg = eventToInboundMessage({ type: "message", user: "U1", text: "x", ts: "2", thread_ts: "1" }, "BOT", "C1");
    expect(msg?.threadTs).toBe("1");
  });
});
