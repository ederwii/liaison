// ---------------------------------------------------------------------------
// socket-transport.ts — the ONLY file that talks to Slack. F2 wiring.
//
// Measured against the installed package (not from memory):
//   node_modules/@slack/socket-mode/dist/src/SocketModeClient.js:346-375
//     • `events_api` envelopes are emitted under the INNER event type
//       ({ack, body, event}); every other envelope type (e.g. `interactive`)
//       is emitted under `event.type` ({ack, body});
//     • `slack_event` receives all of them with `type` attached.
//   We subscribe to `slack_event` only, so this stays correct across both
//   shapes and across package versions.
//
// Interactivity must be ENABLED on the Slack app or `block_actions` envelopes
// are never delivered (see slack-manifest.yml).
// ---------------------------------------------------------------------------
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type {
  ChannelRef, InboundEvent, InboundFile, InboundHandler, InboundMessage,
  InboundReaction, PostParams, PostedRef, ReactionParams, SlackTransport, UpdateParams, UploadParams,
} from "./transport.ts";

/** Hard ceiling on a single downloaded/uploaded file — matches bin/slack-say's own cap. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const HISTORY_MAX_PAGES = 5;
const HISTORY_PAGE_LIMIT = 200;
const HISTORY_PAGE_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Liveness. Observed once in production: the socket went zombie after
// repeated "A pong wasn't received from the server before the timeout of
// 5000ms!" warnings — @slack/socket-mode's own SlackWebSocket DOES call
// disconnect() on that timeout (dist/src/SlackWebSocket.js:357-359), but
// nothing here ever noticed the client had stopped making forward progress
// on reconnection, so the service manager never saw an exit and never
// restarted us.
//
// Deliberately NOT "no events for N seconds" — channels are legitimately
// idle for hours and that would false-positive on silence, not failure.
// Instead this watches the client's own lifecycle: Disconnected/Reconnecting
// held for too long without reaching Connected again, or repeated pong
// timeouts in a short window.
// ---------------------------------------------------------------------------
const DISCONNECTED_FATAL_MS = 60_000;
const PONG_TIMEOUT_WINDOW_MS = 120_000;
const PONG_TIMEOUT_FATAL_COUNT = 3;
const LIVENESS_CHECK_INTERVAL_MS = 15_000;

export interface LivenessOptions {
  now?: () => number;
  disconnectedFatalMs?: number;
  pongTimeoutWindowMs?: number;
  pongTimeoutFatalCount?: number;
  onFatal: (reason: string, fields: Record<string, unknown>) => void;
}

/**
 * Pure decision logic, independent of @slack/socket-mode, so it is testable
 * without a real websocket. `fire()` is one-shot: once a fatal condition is
 * declared, every later call is a no-op (the process is on its way out).
 */
export class SocketLivenessMonitor {
  private readonly now: () => number;
  private readonly disconnectedFatalMs: number;
  private readonly pongTimeoutWindowMs: number;
  private readonly pongTimeoutFatalCount: number;
  private readonly onFatal: (reason: string, fields: Record<string, unknown>) => void;
  private disconnectedSince: number | undefined;
  private pongTimeouts: number[] = [];
  private fired = false;

  constructor(o: LivenessOptions) {
    this.now = o.now ?? (() => Date.now());
    this.disconnectedFatalMs = o.disconnectedFatalMs ?? DISCONNECTED_FATAL_MS;
    this.pongTimeoutWindowMs = o.pongTimeoutWindowMs ?? PONG_TIMEOUT_WINDOW_MS;
    this.pongTimeoutFatalCount = o.pongTimeoutFatalCount ?? PONG_TIMEOUT_FATAL_COUNT;
    this.onFatal = o.onFatal;
  }

  /** State.Connected — the client reached a good state again; forget history. */
  connected(): void {
    this.disconnectedSince = undefined;
    this.pongTimeouts = [];
  }

  /** State.Disconnected */
  disconnected(): void {
    if (this.disconnectedSince === undefined) this.disconnectedSince = this.now();
    this.checkDisconnected();
  }

  /** State.Reconnecting — still not Connected; same bucket as Disconnected. */
  reconnecting(): void {
    if (this.disconnectedSince === undefined) this.disconnectedSince = this.now();
    this.checkDisconnected();
  }

  /** One observed "ping/pong wasn't received" warning from the client's own logger. */
  pongTimeout(): void {
    const t = this.now();
    this.pongTimeouts.push(t);
    this.pongTimeouts = this.pongTimeouts.filter((x) => t - x <= this.pongTimeoutWindowMs);
    if (this.pongTimeouts.length >= this.pongTimeoutFatalCount) {
      this.fire("pong_timeout_repeated", { count: this.pongTimeouts.length, window_ms: this.pongTimeoutWindowMs });
    }
  }

  /** Call on an interval — catches a stuck Disconnected/Reconnecting state even with no new lifecycle events. */
  checkDisconnected(): void {
    if (this.disconnectedSince === undefined || this.fired) return;
    const elapsed = this.now() - this.disconnectedSince;
    if (elapsed > this.disconnectedFatalMs) {
      this.fire("disconnected_too_long", { elapsed_ms: elapsed, threshold_ms: this.disconnectedFatalMs });
    }
  }

  private fire(reason: string, fields: Record<string, unknown>): void {
    if (this.fired) return;
    this.fired = true;
    this.onFatal(reason, fields);
  }
}

export interface SocketModeTransportOptions {
  botToken: string;
  appToken: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** test seam: replaces process.exit so a fatal liveness condition can be asserted without killing the test process */
  exitFn?: (code: number) => void;
  liveness?: Partial<LivenessOptions>;
}

export class SocketModeTransport implements SlackTransport {
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private readonly handlers: InboundHandler[] = [];
  private readonly nameCache = new Map<string, string | undefined>();
  private readonly channelCache = new Map<string, ChannelRef>();
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  botUserId: string | undefined;
  /** who this daemon is connected AS. Names only — never a token. */
  identity: { botUserId?: string; botName?: string; team?: string } | undefined;

  /**
   * Never read back off `this` as a public field — kept private so a stray
   * `JSON.stringify(transport)` or a debug log of `this` cannot leak it.
   * Only `downloadFile` uses it directly; every other Slack call goes through
   * `this.web`, which holds its own copy inside @slack/web-api.
   */
  readonly #botToken: string;

  private readonly liveness: SocketLivenessMonitor;
  private readonly exitFn: (code: number) => void;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;

  constructor(o: SocketModeTransportOptions) {
    this.log = o.log ?? (() => {});
    this.exitFn = o.exitFn ?? ((code) => process.exit(code));
    this.liveness = new SocketLivenessMonitor({
      ...o.liveness,
      onFatal: (reason, fields) => {
        // Structured line FIRST — the service manager restarts us, but only a log line
        // tells the next reader (or a supervisor) why.
        this.log("socket_liveness_fatal", { reason, ...fields });
        this.exitFn(1);
      },
    });
    // Intercepts @slack/socket-mode's own logger instead of letting its
    // default ConsoleLogger print straight to stdout — that's how we learn
    // about a repeated pong timeout, which the library never turns into an
    // event of its own (only a log line + an internal disconnect()).
    const warnSink = (text: string): void => {
      this.log("socket_mode_warn", { text });
      if (/pong wasn't received|ping wasn't received/i.test(text)) this.liveness.pongTimeout();
    };
    const bridgeLogger = {
      debug: () => {},
      info: () => {},
      warn: (...msg: unknown[]) => warnSink(msg.map(String).join(" ")),
      error: (...msg: unknown[]) => this.log("socket_mode_error", { text: msg.map(String).join(" ") }),
      setLevel: () => {},
      getLevel: () => "warn",
      setName: () => {},
    };
    // logLevel default (INFO) spams pong/reconnect lines into the service logs.
    this.socket = new SocketModeClient({ appToken: o.appToken, logLevel: "warn" as never, logger: bridgeLogger as never });
    this.web = new WebClient(o.botToken);
    this.#botToken = o.botToken;
  }

  async start(): Promise<void> {
    const auth = await this.web.auth.test();
    this.botUserId = auth.user_id as string | undefined;
    // Which Slack app am I? The owner can swap the app under us (for example
    // moving from a shared dev app to a dedicated one). "the daemon is running" is
    // not the same claim as "the daemon is running as the app you think".
    this.identity = {
      ...(this.botUserId ? { botUserId: this.botUserId } : {}),
      ...(auth.user ? { botName: auth.user as string } : {}),
      ...(auth.team ? { team: auth.team as string } : {}),
    };
    this.socket.on("slack_event", async (envelope: { ack: () => Promise<void>; type: string; body: unknown }) => {
      // Ack FIRST, always: Slack retries un-acked envelopes and a slow handler
      // would produce duplicates.
      try { await envelope.ack(); } catch { /* already acked / closed */ }
      try { await this.dispatch(envelope.type, envelope.body as Record<string, unknown>); }
      catch (err) { this.log("dispatch_failed", { err: String(err) }); }
    });
    this.socket.on("connected", () => { this.liveness.connected(); this.log("socket_connected", {}); });
    this.socket.on("disconnected", () => { this.liveness.disconnected(); this.log("socket_disconnected", {}); });
    this.socket.on("reconnecting", () => { this.liveness.reconnecting(); this.log("socket_reconnecting", {}); });
    this.socket.on("error", (err: unknown) => { this.log("socket_error", { err: String(err) }); });
    // The lifecycle events above only fire on a TRANSITION. A client stuck in
    // Reconnecting with no further transitions (the actual zombie shape —
    // it kept logging pong timeouts but never got back to Connected and never
    // re-emitted Reconnecting either) needs a periodic poke to notice the
    // clock has kept running underneath it.
    this.livenessTimer = setInterval(() => this.liveness.checkDisconnected(), LIVENESS_CHECK_INTERVAL_MS);
    await this.socket.start();
  }

  async stop(): Promise<void> {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    await this.socket.disconnect();
  }

  onEvent(h: InboundHandler): void { this.handlers.push(h); }

  private async emit(e: InboundEvent): Promise<void> {
    for (const h of this.handlers) await h(e);
  }

  private async dispatch(type: string, body: Record<string, unknown>): Promise<void> {
    if (type === "events_api") {
      const ev = (body as { event?: Record<string, unknown> }).event;
      if (!ev) return;
      const msg = eventToInboundMessage(ev, this.botUserId, (ev["channel"] as string) ?? "");
      if (msg) { await this.emit(msg); return; }
      const reaction = eventToInboundReaction(ev, (ev["channel"] as string) ?? "", this.botUserId);
      if (reaction) await this.emit(reaction);
      return;
    }
    if (type !== "interactive") return;
    if (body["type"] !== "block_actions") return;
    const actions = (body["actions"] as Record<string, unknown>[]) ?? [];
    const action = actions[0];
    if (!action) return;
    const container = (body["container"] as Record<string, unknown>) ?? {};
    const message = (body["message"] as Record<string, unknown>) ?? {};
    await this.emit({
      type: "action",
      channel: ((body["channel"] as Record<string, unknown>)?.["id"] as string) ?? "",
      user: ((body["user"] as Record<string, unknown>)?.["id"] as string) ?? "",
      ts: (container["message_ts"] as string) ?? (message["ts"] as string) ?? "",
      threadTs: (container["thread_ts"] as string) ?? (message["thread_ts"] as string) ?? undefined,
      actionId: action["action_id"] as string,
      value: actionValue(action),
      blockState: readBlockState(body["state"] as Record<string, unknown> | undefined),
    });
  }

  async ensureChannel(name: string): Promise<ChannelRef> {
    const cached = this.channelCache.get(name);
    if (cached) return { ...cached, created: false };
    const found = await this.findChannel(name);
    if (found) {
      // conversations.join is idempotent and needs `channels:join`.
      try { await this.web.conversations.join({ channel: found }); }
      catch (err) { this.log("join_failed", { channel: name, err: String(err) }); }
      const ref: ChannelRef = { id: found, name, created: false };
      this.channelCache.set(name, ref);
      return ref;
    }
    // needs `channels:manage`
    const created = await this.web.conversations.create({ name, is_private: false });
    const id = created.channel?.id as string;
    const ref: ChannelRef = { id, name, created: true };
    this.channelCache.set(name, ref);
    return { ...ref, created: true };
  }

  private async findChannel(name: string): Promise<string | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.web.conversations.list({
        limit: 200, cursor, exclude_archived: true, types: "public_channel",
      });
      const hit = (res.channels ?? []).find((c) => c.name === name);
      if (hit?.id) return hit.id;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) return undefined;
    }
    return undefined;
  }

  /**
   * `conversations.invite` — verified live to work with the
   * `channels:manage` scope this app already has. `already_in_channel` and
   * `cant_invite_self` are successes, not failures: the goal is membership,
   * not the act of inviting.
   */
  async inviteUsers(channel: string, userIds: string[]): Promise<void> {
    const users = userIds.filter((u) => u && u !== this.botUserId);
    if (users.length === 0) return;
    try {
      await this.web.conversations.invite({ channel, users: users.join(",") });
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error ?? String(err);
      if (code === "already_in_channel" || code === "cant_invite_self") return;
      this.log("invite_failed", { channel, count: users.length, err: code });
    }
  }

  async postMessage(p: PostParams): Promise<PostedRef> {
    const res = await this.web.chat.postMessage({
      channel: p.channel,
      text: p.text,
      ...(p.blocks ? { blocks: p.blocks as never } : {}),
      ...(p.threadTs ? { thread_ts: p.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { channel: p.channel, ts: res.ts as string };
  }

  async updateMessage(p: UpdateParams): Promise<void> {
    await this.web.chat.update({
      channel: p.channel, ts: p.ts, text: p.text,
      ...(p.blocks ? { blocks: p.blocks as never } : {}),
    });
  }

  async resolveUserName(userId: string): Promise<string | undefined> {
    if (this.nameCache.has(userId)) return this.nameCache.get(userId);
    let name: string | undefined;
    try {
      const res = await this.web.users.info({ user: userId });
      name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || undefined;
    } catch (err) { this.log("users_info_failed", { user: userId, err: String(err) }); }
    this.nameCache.set(userId, name);
    return name;
  }

  /**
   * `url_private*` links are NOT signed URLs — Slack requires the bot's own
   * `Authorization: Bearer <token>` header, never a query param (that would
   * put the token in a URL that gets logged by caches/proxies).
   */
  async downloadFile(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.#botToken}` } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const len = res.headers.get("content-length");
    if (len && Number(len) > MAX_FILE_BYTES) {
      throw new Error(`file too large (${len} bytes, max ${MAX_FILE_BYTES})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_FILE_BYTES) {
      throw new Error(`file too large (${buf.byteLength} bytes, max ${MAX_FILE_BYTES})`);
    }
    return buf;
  }

  /**
   * Boot-time recovery (zombie-websocket incident): fetch human
   * messages posted since `oldestTs` (a Slack `ts`, seconds.micros) so a
   * backfill step can replay whatever the dead socket missed. Capped pages
   * and a delay between them — this runs once per channel at boot, not on
   * every pump cycle, so it does not need to be fast, only polite.
   * `missing_scope` is reported, never worked around: the caller logs it and
   * moves on rather than retrying or guessing at another endpoint.
   */
  async fetchHistory(channel: string, oldestTs: string): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      let res: Awaited<ReturnType<WebClient["conversations"]["history"]>>;
      try {
        res = await this.web.conversations.history({ channel, oldest: oldestTs, limit: HISTORY_PAGE_LIMIT, cursor });
      } catch (err) {
        const code = (err as { data?: { error?: string } })?.data?.error ?? String(err);
        this.log(code === "missing_scope" ? "history_missing_scope" : "history_failed", { channel, err: code });
        break;
      }
      for (const raw of res.messages ?? []) {
        const msg = eventToInboundMessage(raw as Record<string, unknown>, this.botUserId, channel);
        if (msg && !msg.isBot) out.push(msg);
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
      await sleep(HISTORY_PAGE_DELAY_MS);
    }
    return out.reverse(); // Slack returns newest-first; replay must be oldest-first
  }

  /**
   * Single-message lookup (used to say what an inbound reaction was a
   * reaction to) — `conversations.history`
   * with `latest`+`inclusive`+`limit:1`, which the Slack docs give as the
   * documented way to fetch one message by ts (there is no `conversations.get`).
   * Reuses the already-requested `channels:history` scope; no new scope needed.
   * Returns undefined on any error (missing scope, deleted message, etc.) —
   * the caller treats that as "text unknown", never a crash.
   */
  async fetchMessageText(channel: string, ts: string): Promise<string | undefined> {
    try {
      const res = await this.web.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
      const msg = res.messages?.[0] as Record<string, unknown> | undefined;
      return typeof msg?.["text"] === "string" ? (msg["text"] as string) : undefined;
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error ?? String(err);
      this.log(code === "missing_scope" ? "history_missing_scope" : "message_fetch_failed", { channel, ts, err: code });
      return undefined;
    }
  }

  async uploadFile(p: UploadParams): Promise<PostedRef> {
    await this.web.filesUploadV2({
      channel_id: p.channel,
      file: p.path,                     // a string here is read from disk by the SDK
      filename: p.title ?? p.path.split("/").at(-1) ?? "file",
      ...(p.text ? { initial_comment: p.text } : {}),
      ...(p.threadTs ? { thread_ts: p.threadTs } : {}),
    } as never);
    // filesUploadV2's reply shape nests the posted message under files[].files[]
    // and differs across API versions; nothing downstream threads off an
    // upload's ts today, so a synthetic one is honest rather than brittle.
    return { channel: p.channel, ts: String(Date.now() / 1000) };
  }

  /**
   * `already_reacted` is a success, not a failure: the goal is "this message
   * carries a ✅", and it already does. Any other error propagates so the
   * daemon's normal retry-then-inbox-error path (pump()) handles it — never
   * swallowed, never allowed to crash the daemon's event loop.
   */
  async addReaction(p: ReactionParams): Promise<void> {
    try {
      await this.web.reactions.add({ channel: p.channel, timestamp: p.timestamp, name: p.name });
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (code === "already_reacted") return;
      throw new Error(code ?? String(err));
    }
  }
}

/**
 * Shared by the live `events_api` dispatch path and `fetchHistory` — same
 * filtering rules (message type, subtype allowlist, bot detection) either
 * way, so a backfilled message is held to the exact rule a live one is.
 * Returns undefined for anything that is not a human-relevant message event.
 */
export function eventToInboundMessage(
  ev: Record<string, unknown>, botUserId: string | undefined, channel: string,
): InboundMessage | undefined {
  if (!ev || ev["type"] !== "message") return undefined;
  // edits / joins / deletes carry a subtype we do not act on
  const subtype = ev["subtype"] as string | undefined;
  if (subtype && subtype !== "thread_broadcast" && subtype !== "file_share") return undefined;
  const user = (ev["user"] as string) ?? "";
  const files = parseInboundFiles(ev["files"]);
  return {
    type: "message",
    channel: (ev["channel"] as string) ?? channel,
    user,
    text: (ev["text"] as string) ?? "",
    ts: ev["ts"] as string,
    threadTs: ev["thread_ts"] as string | undefined,
    isBot: Boolean(ev["bot_id"]) || subtype === "bot_message" || (!!botUserId && user === botUserId),
    ...(files.length ? { files } : {}),
  };
}

/**
 * Slack's `reaction_added` / `reaction_removed` -> the inbound shape the
 * daemon acts on. Filters here, not in the daemon — same split as
 * eventToInboundMessage filtering subtype there. Only reactions on a `message`
 * item (not a file, not a canvas) count: there is no message text to report
 * otherwise. Reactions by the bot itself (the ✅ ack echoing back) are dropped
 * here so they never reach the daemon's allowlist check as a warning.
 */
export function eventToInboundReaction(
  ev: Record<string, unknown>, channel: string, botUserId?: string,
): InboundReaction | undefined {
  const type = ev["type"];
  if (type !== "reaction_added" && type !== "reaction_removed") return undefined;
  const item = ev["item"] as Record<string, unknown> | undefined;
  if (!item || item["type"] !== "message") return undefined;
  const user = ev["user"] as string | undefined;
  const itemTs = item["ts"] as string | undefined;
  const emoji = ev["reaction"] as string | undefined;
  if (!user || !itemTs || !emoji) return undefined;
  if (botUserId && user === botUserId) return undefined;
  return {
    type, user, emoji, itemTs,
    channel: (item["channel"] as string) ?? channel,
    eventTs: (ev["event_ts"] as string) ?? "",
  };
}

/** Raw `files[]` off a Slack message event -> transport-neutral shape. */
export function parseInboundFiles(raw: unknown): InboundFile[] {
  if (!Array.isArray(raw)) return [];
  const out: InboundFile[] = [];
  for (const f of raw as Record<string, unknown>[]) {
    const id = f["id"] as string | undefined;
    const name = (f["name"] as string | undefined) ?? "file";
    if (!id) continue;
    out.push({
      id,
      name,
      mimetype: (f["mimetype"] as string | undefined) ?? "application/octet-stream",
      size: (f["size"] as number | undefined) ?? 0,
      urlPrivateDownload: f["url_private_download"] as string | undefined,
      urlPrivate: f["url_private"] as string | undefined,
    });
  }
  return out;
}

export function actionValue(action: Record<string, unknown>): string | undefined {
  if (typeof action["value"] === "string") return action["value"];
  const sel = action["selected_option"] as Record<string, unknown> | undefined;
  if (sel && typeof sel["value"] === "string") return sel["value"];
  return undefined;
}

/** Flatten Slack's state.values into { action_id: [values] }. */
export function readBlockState(state: Record<string, unknown> | undefined): Record<string, string[]> | undefined {
  const values = state?.["values"] as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (!values) return undefined;
  const out: Record<string, string[]> = {};
  for (const block of Object.values(values)) {
    for (const [actionId, el] of Object.entries(block)) {
      const many = el["selected_options"] as { value?: string }[] | undefined;
      if (Array.isArray(many)) { out[actionId] = many.map((o) => o.value ?? "").filter(Boolean); continue; }
      const one = el["selected_option"] as { value?: string } | undefined;
      if (one?.value) { out[actionId] = [one.value]; continue; }
      if (typeof el["value"] === "string") out[actionId] = [el["value"] as string];
    }
  }
  return out;
}
