import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Append-only jsonl. One line == one event Never rewrites. */
export async function appendLine(file: string, obj: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(obj) + "\n", "utf8");
}

export async function readLines<T>(file: string): Promise<T[]> {
  const { entries } = await readFrom<T>(file, 0);
  return entries.map((e) => e.value);
}

export interface Entry<T> { value: T; end: number }

/**
 * Read events appended after byte `offset`. Each entry carries the byte offset
 * AFTER its own line, so a caller can commit progress per-event and never
 * re-deliver something it already acted on.
 *
 * A torn trailing line (a writer caught mid-append) is left unparsed and the
 * returned offset stops before it, so the next read picks it up whole.
 */
export async function readFrom<T>(file: string, offset: number): Promise<{ entries: Entry<T>[]; offset: number }> {
  let size: number;
  try { size = (await stat(file)).size; }
  catch { return { entries: [], offset: 0 }; }
  // File shrank (rotated/truncated) — restart from the top rather than read garbage.
  const from = offset > size ? 0 : offset;
  if (from === size) return { entries: [], offset: from };

  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    const text = buf.toString("utf8");
    const entries: Entry<T>[] = [];
    let cursor = 0;
    for (;;) {
      const nl = text.indexOf("\n", cursor);
      if (nl === -1) break;
      const raw = text.slice(cursor, nl);
      cursor = nl + 1;
      if (!raw.trim()) continue;
      try { entries.push({ value: JSON.parse(raw) as T, end: from + Buffer.byteLength(text.slice(0, cursor), "utf8") }); }
      catch { /* unparseable complete line: skip it, keep the stream moving */ }
    }
    return { entries, offset: from + Buffer.byteLength(text.slice(0, cursor), "utf8") };
  } finally {
    await fh.close();
  }
}
