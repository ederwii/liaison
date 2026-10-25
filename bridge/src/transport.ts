// ---------------------------------------------------------------------------
// transport.ts — THE SEAM. Daemon core knows only this interface. Impls:
//   FakeTransport        (in-process, drives the whole test suite)
//   SocketModeTransport  (@slack/socket-mode + @slack/web-api)
// No daemon logic may import a Slack package. Enforced by test/seam.test.ts.
// ---------------------------------------------------------------------------

export interface ChannelRef {
  id: string;
  name: string;
  created: boolean;
}

export interface PostParams {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}

export interface PostedRef {
  channel: string;
  ts: string;
}

export interface UpdateParams {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

export interface UploadParams {
  channel: string;
  /** absolute local path; the daemon has already size-checked it */
  path: string;
  /** shown as the file's title in Slack; defaults to the basename */
  title?: string;
  /** caption — posted as the upload's initial comment */
  text?: string;
  threadTs?: string;
}

/** Raw Slack file metadata off a `message`/`file_share` event — nothing downloaded yet. */
export interface InboundFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  urlPrivateDownload?: string;
  urlPrivate?: string;
}

export interface InboundMessage {
  type: "message";
  channel: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
  /** messages the bot itself posted — must never round-trip */
  isBot?: boolean;
  /** present only when the message carried attachments */
  files?: InboundFile[];
}

export interface InboundAction {
  type: "action";
  channel: string;
  user: string;
  /** ts of the message the button lives on */
  ts: string;
  threadTs?: string;
  actionId: string;
  /** button / static_select payload value */
  value?: string;
  /** multi_static_select current selection, from Slack's `state.values` */
  blockState?: Record<string, string[]>;
}

/**
 * Someone reacting with an emoji on an already-posted message. Deliberately
 * NOT named ReactionEvent — that name is already taken by types.ts for the
 * opposite direction (the bridge's own ✅ ack, outbound). This is Slack's
 * `reaction_added`/`reaction_removed`, inbound.
 */
export interface InboundReaction {
  type: "reaction_added" | "reaction_removed";
  channel: string;
  user: string;
  /** emoji name, no colons — e.g. "eyes" */
  emoji: string;
  /** ts of the message that was reacted to (NOT the reaction event's own ts) */
  itemTs: string;
  /** Slack's event_ts for this reaction event — idempotency key downstream */
  eventTs: string;
}

export type InboundEvent = InboundMessage | InboundAction | InboundReaction;

export type InboundHandler = (e: InboundEvent) => Promise<void> | void;

export interface SlackTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** find-or-create the channel and make sure the bot is in it */
  ensureChannel(name: string): Promise<ChannelRef>;
  /**
   * Add people to a channel. Called for the allowlist when a channel is first
   * created: a bot-created channel contains ONLY the bot, so without this the
   * owner is never a member, never sees the channel in their sidebar, and every
   * question posted into it is addressed to an empty room.
   * Must tolerate already-a-member and never throw for it.
   */
  inviteUsers(channel: string, userIds: string[]): Promise<void>;
  postMessage(p: PostParams): Promise<PostedRef>;
  updateMessage(p: UpdateParams): Promise<void>;
  /** display name for provenance; undefined if unresolvable */
  resolveUserName(userId: string): Promise<string | undefined>;
  onEvent(h: InboundHandler): void;
  /**
   * Download a Slack-hosted file using this transport's own bot token.
   * Optional: a transport without it fails each attachment into the inbox
   * line as `{ error }`, never a crash.
   */
  downloadFile?(url: string): Promise<Buffer>;
  /**
   * Upload a local file as a message (filesUploadV2 on Slack), with `p.text`
   * as the caption. Optional for the same reason as `downloadFile`.
   */
  uploadFile?(p: UploadParams): Promise<PostedRef>;
  /**
   * Add an emoji reaction to an existing message. Optional — a transport
   * without reactions fails the event into the project's own inbox as an
   * `error` line, never a crash. MUST treat "already reacted" as success,
   * never throw for it: `slack-ack` can run more than once for the same
   * message (e.g. a crashed session re-running `--last`).
   */
  addReaction?(p: ReactionParams): Promise<void>;
  /**
   * Best-effort text of a single already-posted message, by channel+ts, so an
   * inbound reaction can say what it was a reaction to. Optional — a transport
   * without it (or missing scope) still gets the reaction recorded, just with
   * `text: ""`; never a crash.
   */
  fetchMessageText?(channel: string, ts: string): Promise<string | undefined>;
  /**
   * Fetch human messages posted in `channel` since `oldestTs` (oldest-first),
   * for boot-time backfill after a missed-events incident. Optional — a
   * transport without it (or a scope it lacks) is simply skipped by the
   * backfill step, never crashed or worked around.
   */
  fetchHistory?(channel: string, oldestTs: string): Promise<InboundMessage[]>;
}

export interface ReactionParams {
  channel: string;
  timestamp: string;
  /** emoji name, no colons */
  name: string;
}
