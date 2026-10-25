import { describe, expect, test } from "bun:test";
import { ACTION_CHOICE, ACTION_MULTI, ACTION_SUBMIT, buildBlocks, decodeValue, encodeValue, isChoiceAction, settledBlocks } from "../src/blocks.ts";

const find = (blocks: any[], type: string) => blocks.filter((b) => b.type === type);
const actionIds = (blocks: any[]) =>
  blocks.flatMap((b: any) => (b.elements ?? []).map((e: any) => e.action_id).concat(b.accessory ? [b.accessory.action_id] : []));

describe("action values are self-describing", () => {
  test("round-trip question id + option", () => {
    const v = encodeValue("q_1", "Option | with, punctuation");
    expect(decodeValue(v)).toEqual({ q: "q_1", o: "Option | with, punctuation" });
  });
  test("stays inside Slack's 2000-char value limit", () => {
    expect(encodeValue("q_1", "x".repeat(300)).length).toBeLessThanOrEqual(2000);
  });
  test("garbage decodes to null instead of throwing", () => {
    expect(decodeValue("not-json")).toBeNull();
  });
});

describe("buildBlocks per question type", () => {
  test("buttons: one button per option", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "buttons", options: ["A", "B", "C"] }) as any[];
    const actions = find(b, "actions");
    expect(actions).toHaveLength(1);
    expect(actions[0].elements).toHaveLength(3);
    expect(actions[0].elements.map((e: any) => e.text.text)).toEqual(["A", "B", "C"]);
    expect(actions[0].elements.every((e: any) => isChoiceAction(e.action_id))).toBe(true);
    expect(decodeValue(actions[0].elements[0].value)).toEqual({ q: "q1", o: "A" });
  });
  test("yesno: exactly two buttons regardless of options", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "yesno", options: [] }) as any[];
    const els = find(b, "actions")[0].elements;
    expect(els.map((e: any) => decodeValue(e.value)!.o)).toEqual(["yes", "no"]);
  });
  test("select: a static_select, not buttons", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "select", options: ["A", "B"] }) as any[];
    const json = JSON.stringify(b);
    expect(json).toContain("static_select");
    expect(json).not.toContain("multi_static_select");
    expect(actionIds(b)).toContain(ACTION_CHOICE);
  });
  test("multiselect: multi_static_select PLUS a submit button", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "multiselect", options: ["A", "B"] }) as any[];
    expect(JSON.stringify(b)).toContain("multi_static_select");
    expect(actionIds(b)).toContain(ACTION_MULTI);
    expect(actionIds(b)).toContain(ACTION_SUBMIT);
  });
  test("text: no interactive elements, just an instruction to reply in-thread", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "text", options: [] }) as any[];
    expect(find(b, "actions")).toHaveLength(0);
    expect(JSON.stringify(b)).toMatch(/reply/i);
  });
  test("button text is truncated to Slack's 75-char limit", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "buttons", options: ["y".repeat(200)] }) as any[];
    expect(find(b, "actions")[0].elements[0].text.text.length).toBeLessThanOrEqual(75);
  });
});

// F2 REGRESSION (measured against live Slack). Every button used to
// carry the same action_id, and Slack rejects the entire message for it:
//   invalid_blocks: `action_id` "sb_choice" already exists
//                   [json-pointer:/blocks/0/elements/1/action_id]
// That made `buttons` and `yesno` — the two most-used types — undeliverable,
// and no fake could have caught it. Uniqueness is asserted across the whole
// message, not per block, because that is the constraint Slack enforces.
describe("action_id uniqueness (Slack rejects duplicates)", () => {
  const QTYPES = ["buttons", "yesno", "select", "multiselect", "text"] as const;
  for (const qtype of QTYPES) {
    test(`${qtype}: no action_id appears twice in the message`, () => {
      const b = buildBlocks({ questionId: "q1", qtype, options: ["A", "B", "C", "D", "E"] }) as any[];
      const ids = actionIds(b);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
  test("five buttons produce five distinct ids, all still recognised as choices", () => {
    const b = buildBlocks({ questionId: "q1", qtype: "buttons", options: ["A", "B", "C", "D", "E"] }) as any[];
    const ids = actionIds(b);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every(isChoiceAction)).toBe(true);
  });
  test("isChoiceAction still accepts the bare id (static_select) and rejects the others", () => {
    expect(isChoiceAction(ACTION_CHOICE)).toBe(true);
    expect(isChoiceAction(`${ACTION_CHOICE}:3`)).toBe(true);
    expect(isChoiceAction(ACTION_MULTI)).toBe(false);
    expect(isChoiceAction(ACTION_SUBMIT)).toBe(false);
  });
});

describe("settledBlocks", () => {
  test("carries the summary and has no clickable element left", () => {
    const b = settledBlocks("Answered: A") as any[];
    expect(JSON.stringify(b)).toContain("Answered: A");
    expect(find(b, "actions")).toHaveLength(0);
  });
});
