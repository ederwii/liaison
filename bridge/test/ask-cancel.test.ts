import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRig, OWNER, T0, type Rig } from "./harness.ts";
import { ACTION_CHOICE, encodeValue } from "../src/blocks.ts";
import { registerProject } from "../src/register.ts";

describe("daemon: cancel closes a question", () => {
  let rig: Rig;
  beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
  afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

  async function ask(over: Record<string, unknown> = {}) {
    rig.push("alpha", { kind: "ask", question_id: "q1", text: "Ship it?", qtype: "buttons",
      options: ["A", "B"], timeout_ms: 60_000, default: null, on_timeout: "escalate", ...over } as any);
    await rig.daemon.pump();
    return rig.daemon.openQuestions()[0]!;
  }
  const cancel = async (id = "q1", reason = "no longer needed because of X") => {
    rig.push("alpha", { kind: "cancel", question_id: id, reason } as any);
    await rig.daemon.pump();
  };

  test("cancel removes it, edits the blocks message with the reason, no buttons", async () => {
    const q = await ask();
    await cancel();
    expect(rig.daemon.openQuestions()).toHaveLength(0);
    const carrier = rig.tx.posts.find((m) => m.ts === q.blocks_ts)!;
    const upd = carrier.updates.at(-1)!;
    expect(upd.text).toContain("🚫 No longer applies");
    expect(upd.text).toContain("no longer needed because of X");
    expect(JSON.stringify(upd.blocks)).not.toContain("actions");
  });

  test("a cancelled escalate question gets NO reminder after the deadline", async () => {
    const q = await ask();
    await cancel();
    const before = rig.tx.posts.length;
    rig.clock.t = T0 + 120_000;
    await rig.daemon.tick();
    expect(rig.tx.posts.length).toBe(before);
    expect(rig.tx.thread(q.thread_ts).some((m) => m.text.includes(`<@${OWNER}>`))).toBe(false);
  });

  test("a cancelled default question applies NO default", async () => {
    await ask({ default: "B", on_timeout: "default" });
    await cancel();
    rig.clock.t = T0 + 120_000;
    await rig.daemon.tick();
    expect(rig.inbox("alpha").filter((l: any) => l.kind === "answer")).toHaveLength(0);
  });

  test("a late click after cancel is ignored", async () => {
    const q = await ask();
    await cancel();
    await rig.tx.clickButton({ channel: q.channel, user: OWNER, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "A") });
    expect(rig.inbox("alpha").filter((l: any) => l.kind === "answer")).toHaveLength(0);
  });

  test("cancel of an unknown id is harmless", async () => {
    await cancel("nope");
    expect(rig.inbox("alpha").filter((l: any) => l.kind === "error")).toHaveLength(0);
  });
});

describe("CLI: --cancel / --open / --replaces", () => {
  let root: string; let cwd: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sb-cancel-"));
    cwd = join(root, "proj");
    mkdirSync(cwd, { recursive: true });
    await registerProject(root, cwd, "proj");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(args: string[], bin = "slack-ask") {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../bin", bin), ...args], {
      env: { ...process.env, LIAISON_ROOT: root, HOME: root }, stdout: "pipe", stderr: "pipe", cwd,
    });
    const err = await new Response(proc.stderr).text();
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, err, out };
  }
  const Q = "Continue? A = yes continue, B = no stop";
  const outboxLines = () => {
    const f = Bun.spawnSync(["find", root, "-name", "outbox.jsonl"]).stdout.toString().trim();
    return f ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  test("cancel an open question: exit 0, audit record in outbox, --open no longer lists it", async () => {
    const a = await run([Q, "--type", "buttons", "--options", "A,B"]);
    expect(a.code).toBe(0);
    const id = a.out.trim();
    const open1 = await run(["--open"]);
    expect(open1.code).toBe(0);
    expect(open1.out).toContain(id);
    expect(open1.out).toContain("Continue?");
    const c = await run(["--cancel", id, "--reason", "test"]);
    expect(c.code).toBe(0);
    const rec = outboxLines().find((l) => l.kind === "cancel");
    expect(rec).toMatchObject({ kind: "cancel", question_id: id, reason: "test" });
    expect(rec.ts).toBeTruthy();
    expect((await run(["--open"])).out).not.toContain(id);
  });

  test("cancel unknown id: exit 2, nothing written", async () => {
    const c = await run(["--cancel", "q_nope"]);
    expect(c.code).toBe(2);
    expect(c.err).toContain("q_nope");
    expect(outboxLines().filter((l) => l.kind === "cancel")).toHaveLength(0);
  });

  test("cancel twice: second is exit 2", async () => {
    const id = (await run([Q, "--type", "buttons", "--options", "A,B"])).out.trim();
    expect((await run(["--cancel", id])).code).toBe(0);
    expect((await run(["--cancel", id])).code).toBe(2);
  });

  test("--replaces cancels the old and asks the new", async () => {
    const old = (await run([Q, "--type", "buttons", "--options", "A,B"])).out.trim();
    const n = await run(["Another: A = one, B = two", "--type", "buttons", "--options", "A,B", "--replaces", old]);
    expect(n.code).toBe(0);
    const ls = outboxLines();
    expect(ls.find((l) => l.kind === "cancel")).toMatchObject({ question_id: old, reason: "replaced by a new question" });
    expect(ls.filter((l) => l.kind === "ask")).toHaveLength(2);
    const open = (await run(["--open"])).out;
    expect(open).not.toContain(old);
    expect(open).toContain(n.out.trim());
  });

  test("--replaces with an INVALID new ask cancels nothing", async () => {
    const old = (await run([Q, "--type", "buttons", "--options", "A,B"])).out.trim();
    const n = await run(["unexplained", "--type", "buttons", "--options", "A,B", "--replaces", old]);
    expect(n.code).toBe(2);
    expect(outboxLines().filter((l) => l.kind === "cancel")).toHaveLength(0);
    expect((await run(["--open"])).out).toContain(old);
  });
});

describe("slack-wait appends open questions after an owner message", () => {
  async function wait(inboxLine: object) {
    const root = mkdtempSync(join(tmpdir(), "sb-wait-"));
    const bin = join(root, "pbin"); Bun.spawnSync(["mkdir", "-p", bin, join(root, "projx")]);
    Bun.spawnSync(["ln", "-s", join(import.meta.dir, "../bin/slack-ask"), join(bin, "slack-ask")]);
    const old = new Date(Date.now() - 600_000).toISOString();
    await Bun.write(join(root, "projx/outbox.jsonl"), JSON.stringify({ id: "a1", ts: old, kind: "ask", project: "projx", question_id: "q_open1", text: "Do X? A = yes, B = no", qtype: "buttons", options: ["A", "B"] }) + "\n");
    await Bun.write(join(root, "projx/inbox.jsonl"), JSON.stringify(inboxLine) + "\n");
    await Bun.write(join(root, "projx/.last-ts"), "2000-01-01T00:00:00.000Z\n");
    const proc = Bun.spawn(["bash", join(import.meta.dir, "../bin/slack-wait"), "--inbox", join(root, "projx/inbox.jsonl"), "--no-ack"], {
      env: { ...process.env, LIAISON_ROOT: root, HOME: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited; rmSync(root, { recursive: true, force: true });
    return out;
  }
  const now = () => new Date().toISOString();
  test("owner message -> one hint line per open question, after the messages", async () => {
    const out = await wait({ ts: now(), kind: "message", from: "U1", text: "actually, better not" });
    const hint = out.split("\n").find((l) => l.startsWith("[slack-wait] open question q_open1"))!;
    expect(hint).toMatch(/^\[slack-wait\] open question q_open1 \(1\d min ago\): "Do X\? A = yes, B = no" — if this message resolved or changed it: slack-ask --cancel q_open1 --reason '\.\.\.'  \(or --replaces q_open1 when asking again\)$/);
    expect(out.indexOf("actually, better not")).toBeLessThan(out.indexOf("open question"));
    expect(out).toContain("[slack-wait] handled?");
  });
  test("an answer (not a message) adds nothing", async () => {
    const out = await wait({ ts: now(), kind: "answer", question_id: "other", from: "U1", choice: "A" });
    expect(out).not.toContain("open question");
  });
});
