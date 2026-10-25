// ---------------------------------------------------------------------------
// fake-transport.ts — in-process Slack. Records every post, hands out
// monotonic ts values, and lets tests inject clicks/messages as if they came
// down the websocket. Zero network, zero tokens.
// ---------------------------------------------------------------------------
import type {
  ChannelRef, InboundEvent, InboundHandler, InboundMessage, PostParams,
  PostedRef, ReactionParams, SlackTransport, UpdateParams, UploadParams,
} from "./transport.ts";

export interface FakePost extends PostedRef {
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  updates: { text: string; blocks?: unknown[] }[];
}

export class FakeTransport implements SlackTransport {
  readonly posts: FakePost[] = [];
  readonly channels = new Map<string, ChannelRef>();
  /** channel id -> user ids invited, in call order */
  readonly invites = new Map<string, string[]>();
  readonly userNames = new Map<string, string>();
  /** every ensureChannel call, in order — proves join-on-boot actually happens */
  readonly ensureChannelCalls: string[] = [];
  started = false;
  stopped = false;
  /** set to make the next N postMessage calls throw (delivery-failure tests) */
  failPosts = 0;
  /** set to make the next N ensureChannel calls throw */
  failEnsureChannel = 0;
  /** every uploadFile call, in order — F/files tests assert against this */
  readonly uploads: UploadParams[] = [];
  /** url -> bytes, for downloadFile; an unmapped url throws (simulates a dead link) */
  readonly downloads = new Map<string, Buffer>();
  /** every addReaction call, in order */
  readonly reactions: ReactionParams[] = [];
  /** set to make the next N addReaction calls throw (never for "already_reacted" — that's not a throw path here) */
  failReactions = 0;
  /** channel -> messages `fetchHistory` returns (boot-backfill tests). Unset channel = no history support. */
  readonly historyByChannel = new Map<string, InboundMessage[]>();
  /** `${channel}:${ts}` -> text, for fetchMessageText. Unset key = "text unknown". */
  readonly messagesByTs = new Map<string, string>();

  private handlers: InboundHandler[] = [];
  private seq = 0;

  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.stopped = true; this.started = false; }

  /** boot-backfill tests: returns whatever was seeded for `channel`, filtered to `ts > oldestTs`. */
  async fetchHistory(channel: string, oldestTs: string): Promise<InboundMessage[]> {
    const all = this.historyByChannel.get(channel) ?? [];
    return all.filter((m) => Number(m.ts) > Number(oldestTs));
  }

  /** looks up `messagesByTs`; unset = undefined, same as a real missing-scope/deleted message. */
  async fetchMessageText(channel: string, ts: string): Promise<string | undefined> {
    return this.messagesByTs.get(`${channel}:${ts}`);
  }

  async ensureChannel(name: string): Promise<ChannelRef> {
    this.ensureChannelCalls.push(name);
    if (this.failEnsureChannel > 0) { this.failEnsureChannel--; throw new Error("fake_slack_error: ensureChannel failed"); }
    const existing = this.channels.get(name);
    if (existing) return { ...existing, created: false };
    const ref: ChannelRef = { id: `C${(this.channels.size + 1).toString().padStart(6, "0")}`, name, created: true };
    this.channels.set(name, ref);
    return ref;
  }

  /** pre-seed a channel so ensureChannel reports created:false */
  seedChannel(name: string, id: string): void {
    this.channels.set(name, { id, name, created: false });
  }

  async inviteUsers(channel: string, userIds: string[]): Promise<void> {
    const prev = this.invites.get(channel) ?? [];
    this.invites.set(channel, [...prev, ...userIds]);
  }

  async postMessage(p: PostParams): Promise<PostedRef> {
    if (this.failPosts > 0) { this.failPosts--; throw new Error("fake_slack_error: post failed"); }
    this.seq += 1;
    const ts = `${1700000000 + this.seq}.000100`;
    this.posts.push({ channel: p.channel, ts, text: p.text, blocks: p.blocks, threadTs: p.threadTs, updates: [] });
    return { channel: p.channel, ts };
  }

  async updateMessage(p: UpdateParams): Promise<void> {
    const target = this.posts.find((m) => m.channel === p.channel && m.ts === p.ts);
    if (!target) throw new Error(`fake_slack_error: no message ${p.channel}/${p.ts}`);
    target.updates.push({ text: p.text, blocks: p.blocks });
  }

  async resolveUserName(userId: string): Promise<string | undefined> {
    return this.userNames.get(userId);
  }

  async downloadFile(url: string): Promise<Buffer> {
    const buf = this.downloads.get(url);
    if (!buf) throw new Error(`fake_slack_error: no fixture for ${url}`);
    return buf;
  }

  async uploadFile(p: UploadParams): Promise<PostedRef> {
    this.uploads.push(p);
    this.seq += 1;
    return { channel: p.channel, ts: `${1700000000 + this.seq}.000100` };
  }

  async addReaction(p: ReactionParams): Promise<void> {
    if (this.failReactions > 0) { this.failReactions--; throw new Error("fake_slack_error: reaction failed"); }
    this.reactions.push(p);
  }

  onEvent(h: InboundHandler): void { this.handlers.push(h); }

  /** drive an inbound event exactly as Socket Mode would */
  async emit(e: InboundEvent): Promise<void> {
    for (const h of this.handlers) await h(e);
  }

  // ---- convenience drivers used by tests + the smoke run ----

  async clickButton(opts: { channel: string; user: string; threadTs: string; actionId: string; value: string }): Promise<void> {
    await this.emit({
      type: "action", channel: opts.channel, user: opts.user,
      ts: `${1700000000 + ++this.seq}.000100`, threadTs: opts.threadTs,
      actionId: opts.actionId, value: opts.value,
    });
  }

  async selectMulti(opts: { channel: string; user: string; threadTs: string; actionId: string; selected: string[] }): Promise<void> {
    await this.emit({
      type: "action", channel: opts.channel, user: opts.user,
      ts: `${1700000000 + ++this.seq}.000100`, threadTs: opts.threadTs,
      actionId: opts.actionId, blockState: { [opts.actionId]: opts.selected },
    });
  }

  async say(opts: {
    channel: string; user: string; text: string; threadTs?: string;
    files?: NonNullable<Extract<InboundEvent, { type: "message" }>["files"]>;
  }): Promise<void> {
    await this.emit({
      type: "message", channel: opts.channel, user: opts.user, text: opts.text,
      ts: `${1700000000 + ++this.seq}.000100`, threadTs: opts.threadTs,
      ...(opts.files ? { files: opts.files } : {}),
    });
  }

  /** all posts in a thread, oldest first */
  thread(threadTs: string): FakePost[] {
    return this.posts.filter((p) => p.threadTs === threadTs || p.ts === threadTs);
  }

  reset(): void {
    this.posts.length = 0; this.channels.clear(); this.invites.clear();
    this.ensureChannelCalls.length = 0; this.uploads.length = 0; this.downloads.clear();
    this.reactions.length = 0;
    this.seq = 0;
    this.failPosts = 0; this.failEnsureChannel = 0; this.failReactions = 0;
  }
}
