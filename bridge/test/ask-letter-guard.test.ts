import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateButtonLetters } from "../src/args.ts";

const OK = "What do we do? A = open the PR, B) wait for the owner, C: something else";

describe("validateButtonLetters", () => {
  test("valid call passes", () => {
    expect(validateButtonLetters(OK, ["A", "B", "C"])).toBeUndefined();
    expect(validateButtonLetters("A - yes, do it. B — no, do not", ["A", "B"])).toBeUndefined();
  });
  test("labels with words are refused", () => {
    expect(validateButtonLetters(OK, ["Yes open", "No"])).toMatch(/A.?H/);
  });
  test("lowercase / multi-letter / out of range refused", () => {
    expect(validateButtonLetters(OK, ["a", "b"])).toBeDefined();
    expect(validateButtonLetters(OK, ["AB", "C"])).toBeDefined();
    expect(validateButtonLetters("A = x yy, I = zzz", ["A", "I"])).toBeDefined();
  });
  test("duplicates and fewer than 2 refused", () => {
    expect(validateButtonLetters(OK, ["A", "A"])).toBeDefined();
    expect(validateButtonLetters(OK, ["A"])).toBeDefined();
    expect(validateButtonLetters(OK, [])).toBeDefined();
  });
  test("must be consecutive from A", () => {
    expect(validateButtonLetters(OK, ["A", "C"])).toBeDefined();
    expect(validateButtonLetters(OK, ["B", "C"])).toBeDefined();
  });
  test("every letter must be explained in the text", () => {
    expect(validateButtonLetters("Continue? A = open the PR, B) wait", ["A", "B", "C"])).toMatch(/C/);
    expect(validateButtonLetters("Continue? A = open the PR", ["A", "B"])).toMatch(/B/);
  });
  test("explanation needs >=3 non-space chars and a standalone uppercase token", () => {
    expect(validateButtonLetters("B = wait, A = ab", ["A", "B"])).toMatch(/"A"/);
    expect(validateButtonLetters("Pick CASE = open, A = yes please", ["A", "B"])).toMatch(/"B"/);
    expect(validateButtonLetters("the ball: open; A = yes now", ["A", "B"])).toMatch(/"B"/);
    expect(validateButtonLetters("a = open, B = wait", ["A", "B"])).toMatch(/"A"/);
  });
  test("error names the rule and includes an example", () => {
    const e = validateButtonLetters("x", ["Si", "No"])!;
    expect(e).toContain("slack-ask 'Which one? A = ship it, B = hold' --type buttons --options 'A,B'");
    expect(e).toMatch(/Rule broken/);
    expect(e).toMatch(/Nothing was sent/);
  });
});

describe("bin/slack-ask refuses before any side effect", () => {
  async function run(args: string[]) {
    const root = mkdtempSync(join(tmpdir(), "sb-guard-"));
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../bin/slack-ask"), ...args], {
      env: { ...process.env, LIAISON_ROOT: root, HOME: root },
      stdout: "pipe", stderr: "pipe", cwd: root,
    });
    const err = await new Response(proc.stderr).text();
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, err, out, files: readdirSync(root).filter((f) => f !== ".bun") };
  }
  test("bad labels: exit 2, one error, nothing written", async () => {
    const r = await run(["test", "--type", "buttons", "--options", "Yes open,No"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("--options 'A,B'");
    expect(r.files).toEqual([]);
  });
  test("letters but unexplained: exit 2, nothing written", async () => {
    const r = await run(["Continue?", "--type", "buttons", "--options", "A,B"]);
    expect(r.code).toBe(2);
    expect(r.files).toEqual([]);
  });
  test("buttons with no --options: exit 2", async () => {
    const r = await run(["Continue? A = yes now, B = no", "--type", "buttons"]);
    expect(r.code).toBe(2);
    expect(r.files).toEqual([]);
  });
});
