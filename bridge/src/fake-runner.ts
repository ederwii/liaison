// ---------------------------------------------------------------------------
// fake-runner.ts — lets the REAL daemon entrypoint run with no Slack app and
// no tokens, driven entirely by two files. Used by `bun run smoke` so the
// smoke test exercises the actual process (spawn, boot, signals, shutdown),
// not just the core class.
//
//   <root>/_fake_in.jsonl     you append InboundEvent lines  -> daemon sees them
//   <root>/_fake_posts.jsonl  daemon posts/updates           -> you read them
// ---------------------------------------------------------------------------
import { appendLine, readFrom } from "./jsonl.ts";
import type { FakeTransport } from "./fake-transport.ts";
import type { InboundEvent } from "./transport.ts";
import { join } from "node:path";

export class FakeFileBridge {
  private inOffset = 0;
  private mirrored = 0;
  private updateCounts = new Map<string, number>();

  // Explicit fields, NOT constructor parameter properties: parameter properties
  // are the one TypeScript form Node's default strip-only type stripping cannot
  // handle, and the daemon may run under Node (Bun's
  // built-in `undici` shim has no `ping`, which reconnect-loops Socket Mode).
  private readonly tx: FakeTransport;
  private readonly root: string;

  constructor(tx: FakeTransport, root: string) {
    this.tx = tx;
    this.root = root;
  }

  private get inFile(): string { return join(this.root, "_fake_in.jsonl"); }
  private get postsFile(): string { return join(this.root, "_fake_posts.jsonl"); }

  async poll(): Promise<void> {
    const { entries, offset } = await readFrom<InboundEvent>(this.inFile, this.inOffset);
    this.inOffset = offset;
    for (const { value } of entries) await this.tx.emit(value);
    await this.mirrorPosts();
  }

  private async mirrorPosts(): Promise<void> {
    for (let i = this.mirrored; i < this.tx.posts.length; i++) {
      const p = this.tx.posts[i]!;
      await appendLine(this.postsFile, {
        kind: "post", channel: p.channel, ts: p.ts, text: p.text,
        threadTs: p.threadTs ?? null, blocks: p.blocks ?? null,
      });
    }
    this.mirrored = this.tx.posts.length;
    for (const p of this.tx.posts) {
      const seen = this.updateCounts.get(p.ts) ?? 0;
      for (let i = seen; i < p.updates.length; i++) {
        await appendLine(this.postsFile, { kind: "update", channel: p.channel, ts: p.ts, text: p.updates[i]!.text });
      }
      this.updateCounts.set(p.ts, p.updates.length);
    }
  }
}
