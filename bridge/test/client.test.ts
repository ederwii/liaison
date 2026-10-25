import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask, drainInbox, projectSlug, say } from "../src/client.ts";
import { appendLine, readLines } from "../src/jsonl.ts";
import type { AskEvent, SayEvent } from "../src/types.ts";

let root: string;
const CWD = "/home/me/alpha-v2";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-client-"));
  mkdirSync(join(root, "alpha-v2"), { recursive: true });
  // The registry decides routing: alpha-v2 is registered, anything else falls to the office.
  writeFileSync(join(root, "projects.yml"), `office:
  path: /home/me/office
projects:
  - slug: alpha-v2
    channel: liaison-alpha-v2
    paths:
      - ${CWD}
`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("slack-say writes one outbox line and returns immediately", () => {
  test("resolves the project from cwd and appends a say event", async () => {
    const e = await say({ root, cwd: CWD, text: "hello" });
    expect(e.kind).toBe("say");
    expect(e.project).toBe("alpha-v2");
    const lines = await readLines<SayEvent>(join(root, "alpha-v2", "outbox.jsonl"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "say", text: "hello", project: "alpha-v2" });
    expect(lines[0]!.id).toBe(e.id);
  });
  test("--urgent is carried through", async () => {
    await say({ root, cwd: CWD, text: "!", urgent: true });
    const [l] = await readLines<SayEvent>(join(root, "alpha-v2", "outbox.jsonl"));
    expect(l!.urgent).toBe(true);
  });
});

describe("slack-ask mints the question id client-side (no waiting on the daemon)", () => {
  test("returns a question id and writes the ask event", async () => {
    const e = await ask({ root, cwd: CWD, text: "Ship?", type: "buttons", options: ["A", "B"], timeout: "30m", default: "B" });
    expect(e.question_id).toMatch(/^q_/);
    const [l] = await readLines<AskEvent>(join(root, "alpha-v2", "outbox.jsonl"));
    expect(l).toMatchObject({
      kind: "ask", qtype: "buttons", options: ["A", "B"],
      timeout_ms: 1_800_000, default: "B", on_timeout: "default", question_id: e.question_id,
    });
  });
  test("two asks get two different ids", async () => {
    const a = await ask({ root, cwd: CWD, text: "1", type: "yesno" });
    const b = await ask({ root, cwd: CWD, text: "2", type: "yesno" });
    expect(a.question_id).not.toBe(b.question_id);
  });
  test("yesno gets yes/no options for free", async () => {
    const e = await ask({ root, cwd: CWD, text: "?", type: "yesno" });
    expect(e.options).toEqual(["yes", "no"]);
  });
  test("a default that is not one of the options is rejected BEFORE anything is written", async () => {
    await expect(ask({ root, cwd: CWD, text: "?", type: "buttons", options: ["A", "B"], default: "Z" }))
      .rejects.toThrow(/default/i);
    expect(await readLines(join(root, "alpha-v2", "outbox.jsonl"))).toEqual([]);
  });
  test("a choice question with no options is rejected", async () => {
    await expect(ask({ root, cwd: CWD, text: "?", type: "buttons", options: [] })).rejects.toThrow(/option/i);
  });
  test("yesno with --options is rejected BEFORE anything is written (options would otherwise be silently dropped)", async () => {
    await expect(ask({ root, cwd: CWD, text: "?", type: "yesno", options: ["A", "B", "C"] }))
      .rejects.toThrow(/--type is yesno/i);
    expect(await readLines(join(root, "alpha-v2", "outbox.jsonl"))).toEqual([]);
  });
  test("on-timeout=default demands a default", async () => {
    await expect(ask({ root, cwd: CWD, text: "?", type: "buttons", options: ["A"], timeout: "5m", onTimeout: "default" }))
      .rejects.toThrow(/default/i);
  });
  test("no timeout given => no timer, and on_timeout defaults to escalate", async () => {
    const e = await ask({ root, cwd: CWD, text: "?", type: "text" });
    expect(e.timeout_ms).toBeNull();
    expect(e.on_timeout).toBe("escalate");
  });
});

describe("drainInbox — a session reads only what it has not seen", () => {
  test("returns new lines and advances its own cursor", async () => {
    const inbox = join(root, "alpha-v2", "inbox.jsonl");
    await appendLine(inbox, { kind: "message", text: "one" });
    expect((await drainInbox({ root, cwd: CWD })).map((l: any) => l.text)).toEqual(["one"]);
    expect(await drainInbox({ root, cwd: CWD })).toEqual([]);
    await appendLine(inbox, { kind: "message", text: "two" });
    expect((await drainInbox({ root, cwd: CWD })).map((l: any) => l.text)).toEqual(["two"]);
  });
  test("an answer written while no session existed is still there for the next one", async () => {
    const inbox = join(root, "alpha-v2", "inbox.jsonl");
    await appendLine(inbox, { kind: "answer", question_id: "q1", choice: "A" });
    const fresh = await drainInbox({ root, cwd: CWD, reader: "brand-new-session" });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ kind: "answer", choice: "A" });
  });
  test("--all replays the whole history without touching the cursor", async () => {
    const inbox = join(root, "alpha-v2", "inbox.jsonl");
    await appendLine(inbox, { kind: "message", text: "one" });
    await drainInbox({ root, cwd: CWD });
    expect(await drainInbox({ root, cwd: CWD, all: true })).toHaveLength(1);
    expect(await drainInbox({ root, cwd: CWD })).toEqual([]);
  });
  test("separate readers keep separate cursors", async () => {
    const inbox = join(root, "alpha-v2", "inbox.jsonl");
    await appendLine(inbox, { kind: "message", text: "one" });
    expect(await drainInbox({ root, cwd: CWD, reader: "a" })).toHaveLength(1);
    expect(await drainInbox({ root, cwd: CWD, reader: "b" })).toHaveLength(1);
    expect(await drainInbox({ root, cwd: CWD, reader: "a" })).toHaveLength(0);
  });
});
