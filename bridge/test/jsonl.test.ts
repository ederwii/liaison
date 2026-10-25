import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, readFrom, readLines } from "../src/jsonl.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jsonl-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("append-only jsonl", () => {
  test("one line per event, never rewrites earlier lines", async () => {
    const f = join(dir, "a.jsonl");
    await appendLine(f, { n: 1 });
    await appendLine(f, { n: 2 });
    const raw = readFileSync(f, "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(raw.endsWith("\n")).toBe(true);
    expect(await readLines(f)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  test("creates parent directories", async () => {
    const f = join(dir, "deep", "b.jsonl");
    await appendLine(f, { ok: true });
    expect(await readLines(f)).toEqual([{ ok: true }]);
  });
  test("missing file reads as empty, not an error", async () => {
    expect(await readLines(join(dir, "nope.jsonl"))).toEqual([]);
    expect(await readFrom(join(dir, "nope.jsonl"), 0)).toEqual({ entries: [], offset: 0 });
  });
  test("readFrom resumes at a byte offset and reports a per-event offset", async () => {
    const f = join(dir, "c.jsonl");
    await appendLine(f, { n: 1 });
    const first = await readFrom<{ n: number }>(f, 0);
    expect(first.entries.map((e) => e.value)).toEqual([{ n: 1 }]);
    await appendLine(f, { n: 2 });
    await appendLine(f, { n: 3 });
    const rest = await readFrom<{ n: number }>(f, first.offset);
    expect(rest.entries.map((e) => e.value)).toEqual([{ n: 2 }, { n: 3 }]);
    // committing after event 2 only must not replay event 2
    const after2 = await readFrom<{ n: number }>(f, rest.entries[0]!.end);
    expect(after2.entries.map((e) => e.value)).toEqual([{ n: 3 }]);
  });
  test("a torn trailing line is left for the next read, not parsed", async () => {
    const f = join(dir, "d.jsonl");
    await appendLine(f, { n: 1 });
    await Bun.write(f, readFileSync(f, "utf8") + '{"n":2');
    const r = await readFrom<{ n: number }>(f, 0);
    expect(r.entries.map((e) => e.value)).toEqual([{ n: 1 }]);
    expect(r.offset).toBe(readFileSync(f, "utf8").indexOf('{"n":2'));
  });
});
