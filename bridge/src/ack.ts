// ---------------------------------------------------------------------------
// ack.ts — the pure logic behind bin/slack-ack, split out so it is unit
// testable without spawning the CLI: build the outbox line, and pick which
// inbox line `--last` means. No fs, no Slack — bin/slack-ack owns the I/O.
// ---------------------------------------------------------------------------
import { newId } from "./ids.ts";
import type { InboxLine, ReactionEvent } from "./types.ts";

/** The one reaction this whole feature ever queues. */
export const ACK_REACTION_NAME = "white_check_mark";

export function buildAckReaction(project: string, channel: string, slackTs: string): ReactionEvent {
  return {
    id: newId("reaction"),
    ts: new Date().toISOString(),
    kind: "reaction",
    project,
    channel,
    slack_ts: slackTs,
    name: ACK_REACTION_NAME,
  };
}

/**
 * True for exactly the inbox lines `--last` is allowed to ack: a message from
 * the owner, or a real (non-timeout) answer. Never a `blocked`/`error` line —
 * nothing was "said" there — and never a timeout-applied answer (`from ===
 * "system"`), because nobody read anything; the daemon decided on its own.
 */
export function isAckableOwnerLine(line: InboxLine): line is InboxLine & { channel: string; slack_ts: string } {
  if (line.kind === "message") return true;
  if (line.kind === "answer") return line.from !== "system";
  return false;
}

/**
 * The newest ackable line not already in `acked` — the exact target of
 * `slack-ack --last`. Lines are assumed oldest-first, as drainInbox/readLines
 * always returns them.
 */
export function selectNewestUnacked(
  lines: InboxLine[],
  acked: ReadonlySet<string>,
): (InboxLine & { channel: string; slack_ts: string }) | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!isAckableOwnerLine(line)) continue;
    if (acked.has(line.slack_ts)) continue;
    return line;
  }
  return undefined;
}

/** Parse the `.acked` file's content (one slack_ts per line) into a set. */
export function parseAckedFile(raw: string): Set<string> {
  return new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean));
}
