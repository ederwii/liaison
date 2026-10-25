// ---------------------------------------------------------------------------
// text.ts — every string the daemon says IN A CHANNEL, in one file. The daemon
// core reads from TEXT and never writes channel-facing prose inline.
//
// Slack mrkdwn: *bold*, _italic_, :emoji: shortcodes. These are the exact
// bytes the daemon posts; test/ack.test.ts and friends pin them.
// ---------------------------------------------------------------------------
import type { OnTimeout, QuestionType } from "./types.ts";

export interface RenderedQuestion {
  /** the question text, already mention-decorated when urgent */
  text: string;
  qtype: QuestionType;
  options: string[];
  /** human duration ("30m"), or null when the question never expires */
  timeoutLabel: string | null;
  default: string | null;
  onTimeout: OnTimeout;
}

export const TEXT = {
  questionBody(q: RenderedQuestion): string {
    const meta: string[] = [];
    if (q.timeoutLabel !== null) meta.push(`answer within ${q.timeoutLabel}`);
    if (q.default !== null && q.onTimeout === "default") meta.push(`default: *${q.default}*`);
    else if (q.onTimeout === "block") meta.push("no default — work blocks on your answer");
    return meta.length ? `${q.text}\n_${meta.join(" · ")}_` : q.text;
  },
  /** the message that carries the interactive blocks */
  blocksCarrier: () => "Answer above ↑",
  paused: () => ":mute: Paused. This channel will stay quiet until you say `resume`.",
  resumed: (n: number) => `:speaker: Resumed. ${n} message(s) were suppressed while paused.`,
  needSelection: () => "Please select at least one option before submitting.",
  escalate: (mention: string) =>
    `${mention}:bell: still waiting on this one — no default was set, so nothing will move until you answer.`,
  timeoutBlocked: () =>
    ":no_entry: Timed out with no default — the session is *blocked* on this. Answer here and re-run when you can.",
  timeoutApplied: (v: string) => `:hourglass: Timed out — applied the default *${v}* and moved on.`,
  // The ACK. On Slack this REPLACES the interactive blocks in place, so the
  // question cannot be answered twice and the confirmation costs no new message.
  settledSummary: (v: string, who: string) => `:white_check_mark: Received *${v}* — answered by ${who}, delivered to the session`,
  timeoutSummary: (v: string) => `:hourglass: Timed out — applied default *${v}*`,
  cancelled: (r: string) => `🚫 No longer applies — ${r}`,
};
