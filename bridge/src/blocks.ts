import type { QuestionType } from "./types.ts";

export const ACTION_CHOICE = "sb_choice";
export const ACTION_MULTI = "sb_multi";
export const ACTION_SUBMIT = "sb_submit";

/**
 * Slack rejects a whole message with `invalid_blocks` if two elements share an
 * `action_id` — measured against the live API:
 *
 *   [ERROR] `action_id` "sb_choice" already exists
 *           [json-pointer:/blocks/0/elements/1/action_id]
 *
 * So every button gets its own id. The option itself still travels in `value`
 * (see encodeValue), which is what the daemon actually reads; the id only has
 * to say what KIND of action this is, and `isChoiceAction` answers that for
 * both the suffixed buttons and the single bare-id static_select.
 */
export function choiceActionId(index: number): string {
  return `${ACTION_CHOICE}:${index}`;
}

export function isChoiceAction(actionId: string): boolean {
  return actionId === ACTION_CHOICE || actionId.startsWith(`${ACTION_CHOICE}:`);
}

const MAX_BUTTON_TEXT = 75;   // Slack button/option text limit
const MAX_VALUE = 2000;       // Slack action value limit

/**
 * Action values carry the question id as well as the option, so a click is
 * self-describing even if the daemon lost its thread map (restart, resync).
 */
export function encodeValue(questionId: string, option: string): string {
  const v = JSON.stringify({ q: questionId, o: option });
  if (v.length <= MAX_VALUE) return v;
  return JSON.stringify({ q: questionId, o: option.slice(0, MAX_VALUE - questionId.length - 40) });
}

export function decodeValue(value: string): { q: string; o: string } | null {
  try {
    const p = JSON.parse(value) as { q?: unknown; o?: unknown };
    if (typeof p.q === "string" && typeof p.o === "string") return { q: p.q, o: p.o };
    return null;
  } catch { return null; }
}

const trunc = (s: string, n = MAX_BUTTON_TEXT) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const plain = (s: string) => ({ type: "plain_text", text: trunc(s), emoji: true });
const option = (o: string, q: string) => ({ text: plain(o), value: encodeValue(q, o) });

export function buildBlocks(o: { questionId: string; qtype: QuestionType; options: string[] }): unknown[] {
  const { questionId: q, qtype } = o;
  switch (qtype) {
    case "yesno":
      return [{
        type: "actions",
        block_id: `sb_${q}`,
        elements: [
          { type: "button", action_id: choiceActionId(0), text: plain("Yes"), style: "primary", value: encodeValue(q, "yes") },
          { type: "button", action_id: choiceActionId(1), text: plain("No"), style: "danger", value: encodeValue(q, "no") },
        ],
      }];
    case "buttons":
      return [{
        type: "actions",
        block_id: `sb_${q}`,
        elements: o.options.slice(0, 5).map((opt, i) => ({
          type: "button", action_id: choiceActionId(i), text: plain(opt), value: encodeValue(q, opt),
        })),
      }];
    case "select":
      return [{
        type: "section",
        block_id: `sb_${q}`,
        text: { type: "mrkdwn", text: "Pick one:" },
        accessory: {
          type: "static_select", action_id: ACTION_CHOICE,
          placeholder: plain("Choose…"),
          options: o.options.map((opt) => option(opt, q)),
        },
      }];
    case "multiselect":
      return [
        {
          type: "section",
          block_id: `sb_${q}`,
          text: { type: "mrkdwn", text: "Pick any:" },
          accessory: {
            type: "multi_static_select", action_id: ACTION_MULTI,
            placeholder: plain("Choose…"),
            options: o.options.map((opt) => option(opt, q)),
          },
        },
        {
          type: "actions",
          block_id: `sb_submit_${q}`,
          elements: [{ type: "button", action_id: ACTION_SUBMIT, style: "primary", text: plain("Submit"), value: encodeValue(q, "submit") }],
        },
      ];
    case "text":
      return [{ type: "context", block_id: `sb_${q}`, elements: [{ type: "mrkdwn", text: "_Reply in this thread with your answer._" }] }];
  }
}

/** What replaces the interactive blocks once a question is settled. */
export function settledBlocks(summary: string): unknown[] {
  return [{ type: "context", elements: [{ type: "mrkdwn", text: summary }] }];
}
