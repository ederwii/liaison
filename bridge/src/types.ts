// ---------------------------------------------------------------------------
// types.ts — THE PROTOCOL. This file is the contract between Claude sessions
// and the daemon. It is deliberately transport-agnostic: the day sessions run
// in the cloud, only the reader/writer changes, never these shapes.
//
// Files, append-only, one JSON object per line:
//   ~/.liaison/<project>/outbox.jsonl   session -> daemon
//   ~/.liaison/<project>/inbox.jsonl    daemon  -> session
// ---------------------------------------------------------------------------

export type QuestionType = "buttons" | "yesno" | "select" | "multiselect" | "text";
export type OnTimeout = "default" | "escalate" | "block";

/** session -> daemon */
export interface SayEvent {
  id: string;
  ts: string;
  kind: "say";
  project: string;
  text: string;
  /** true => @mention the owner (noise control) */
  urgent?: boolean;
  /** post into an existing question thread instead of the channel root */
  question_id?: string;
  /** when set, upload this local file (filesUploadV2) with `text` as the caption instead of chat.postMessage */
  file?: { path: string; title?: string };
}

export interface AskEvent {
  id: string;
  ts: string;
  kind: "ask";
  project: string;
  question_id: string;
  text: string;
  qtype: QuestionType;
  options: string[];
  /** null = wait forever (no timer armed) */
  timeout_ms: number | null;
  /** must be one of `options` when qtype is choice-like and on_timeout=default */
  default: string | null;
  on_timeout: OnTimeout;
  urgent?: boolean;
}

/**
 * session -> daemon. React to an already-delivered message: the mechanical
 * "I read this" signal. Never emitted by the daemon on ingest — that would
 * mean "received", not "read". Only a session, after it has actually read the
 * line, should cause this to be queued (see bin/slack-ack).
 */
export interface ReactionEvent {
  id: string;
  ts: string;
  kind: "reaction";
  project: string;
  channel: string;
  slack_ts: string;
  /** emoji name, no colons — e.g. "white_check_mark" */
  name: string;
}

/**
 * session -> daemon. The question no longer applies (superseded or resolved in
 * conversation). The daemon forgets it — no reminder, no timeout default — and
 * edits the buttons away to say it was cancelled. This line
 * IS the audit record; it is also how the client knows the question is closed.
 */
export interface CancelEvent {
  id: string;
  ts: string;
  kind: "cancel";
  project: string;
  question_id: string;
  reason: string;
}

export type OutboxEvent = SayEvent | AskEvent | ReactionEvent | CancelEvent;

/** daemon -> session */
export interface AnswerLine {
  ts: string;
  kind: "answer";
  question_id: string;
  /** Slack user id of the answerer, or "system" for a timeout default */
  from: string;
  text?: string;
  choice?: string;
  choices?: string[];
  channel: string;
  slack_ts: string;
  // ---- provenance ----
  answered_by: string;
  via: "slack" | "timeout-default";
  executed_by: string;
  authority: "owner-decision" | "system-default";
  /** display/real name of the person (absent for a timeout default) */
  from_name?: string;
  /** "owner" = global allowlist, "admin" = this project's `admins:` */
  role?: PersonRole;
}

export type PersonRole = "owner" | "admin";

/**
 * One file attached to an inbound Slack message. `path` is absolute and set
 * only when the download succeeded; otherwise `error` explains why and no
 * bytes were written to disk. Never a schema change to the other fields —
 * consumers filtering by `.last-ts` must keep working untouched.
 */
export interface InboxFileRef {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  path?: string;
  error?: string;
}

export interface MessageLine {
  ts: string;
  kind: "message";
  from: string;
  text: string;
  channel: string;
  slack_ts: string;
  /** display/real name of the sender (users.info, cached) */
  from_name?: string;
  role?: PersonRole;
  /** present only when the Slack message carried attachments */
  files?: InboxFileRef[];
}

/** The question cannot be answered. Never stall silently. */
export interface BlockedLine {
  ts: string;
  kind: "blocked";
  question_id: string;
  reason: "timeout_block" | "channel_paused";
  text: string;
  channel?: string;
  slack_ts?: string;
}

/** Outbound delivery failed permanently. */
export interface ErrorLine {
  ts: string;
  kind: "error";
  ref_id: string;
  reason: string;
  detail?: string;
}

/**
 * daemon -> session. An allowlisted person reacted with an emoji (or removed
 * it) on a message in this project's channel. Intake only: this line does not
 * decide anything, it just records the fact. `text` is the reacted message's
 * text, fetched via `fetchMessageText`; empty when the transport cannot fetch
 * it. `event_ts` is Slack's own id for this reaction event — a consumer's
 * idempotency key, never re-derived here.
 */
export interface ReactionLine {
  ts: string;
  kind: "reaction";
  action: "added" | "removed";
  reactor: string;
  /** emoji name, no colons */
  emoji: string;
  channel: string;
  /** ts of the message that was reacted to */
  slack_ts: string;
  text: string;
  event_ts: string;
  /** who reacted, by name, and whether they are the owner or a project admin */
  from_name?: string;
  role?: PersonRole;
}

export type InboxLine = AnswerLine | MessageLine | BlockedLine | ErrorLine | ReactionLine;

// --------------------------- daemon-internal state -------------------------

export interface OpenQuestion {
  question_id: string;
  project: string;
  channel: string;
  /** parent message ts == the thread key */
  thread_ts: string;
  /** ts of the threaded message carrying the interactive blocks */
  blocks_ts: string;
  qtype: QuestionType;
  options: string[];
  default: string | null;
  on_timeout: OnTimeout;
  /** epoch ms; null = never expires */
  expires_at: number | null;
  /** on_timeout=escalate fires once, then the question stays open */
  escalated: boolean;
  /** the question header as posted (so a cancel can strike it through) */
  header?: string;
  /** latest multiselect selection seen before Submit */
  pending_choices?: string[];
}

export interface ProjectConfig {
  slug: string;
  channel: string;
  /** absolute repo paths that resolve to this project */
  paths: string[];
  /**
   * Per-project admins: user ids obeyed in THIS project's
   * channel exactly like the owner, nowhere else. Present only when declared:
   * parseProjectsYml only sets it when the file says so, because the daemon
   * diffs the parsed registry by JSON and an unrequested key would look like a
   * change on every reload. Hot-reloaded with the file.
   */
  admins?: string[];
}
