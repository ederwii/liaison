// ---------------------------------------------------------------------------
// daemon.ts — THE CORE. Knows the protocol, the questions, the allowlist and
// the clock. Knows nothing about Slack beyond the SlackTransport interface.
//
// Two deliberate design choices make this testable and crash-safe:
//   • No timers. `tick(now)` expires questions; production calls it on an
//     interval, tests call it directly. The clock is injected.
//   • No fs.watch. `pump()` reads each outbox from a durable byte cursor and
//     commits per event, so a crash mid-batch re-delivers at most the one
//     event that was in flight.
// ---------------------------------------------------------------------------
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InboundFile, InboundReaction, SlackTransport, InboundEvent } from "./transport.ts";
import { TEXT } from "./text.ts";
import { daemonProjects, parseRegistry, type DaemonConfig } from "./config.ts";
import type {
  AnswerLine, AskEvent, BlockedLine, ErrorLine, InboxFileRef, InboxLine, MessageLine,
  CancelEvent, OpenQuestion, OutboxEvent, PersonRole, ProjectConfig, ReactionEvent, SayEvent,
} from "./types.ts";
import { ACTION_MULTI, ACTION_SUBMIT, buildBlocks, decodeValue, isChoiceAction, settledBlocks } from "./blocks.ts";
import { appendLine, readFrom } from "./jsonl.ts";
import { bridgePaths, channelForSlug, sanitizeFileName } from "./paths.ts";
import { formatDuration } from "./duration.ts";

export type LogLevel = "info" | "warn" | "error";
export interface LogRecord { level: LogLevel; msg: string; fields?: Record<string, unknown> }

export interface DaemonOptions {
  transport: SlackTransport;
  config: DaemonConfig;
  now?: () => number;
  log?: (r: LogRecord) => void;
}

interface PausedState { since: number; suppressed: number }

interface PersistedState {
  version: 1;
  cursors: Record<string, number>;
  questions: Record<string, OpenQuestion>;
  paused: Record<string, PausedState>;
  /** channel name -> channel id */
  channels: Record<string, string>;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const PAUSE_CMD = /^(pause|resume)$/i;

export class Daemon {
  readonly logs: LogRecord[] = [];
  private readonly tx: SlackTransport;
  private readonly cfg: DaemonConfig;
  private readonly nowFn: () => number;
  private readonly sink: (r: LogRecord) => void;
  private readonly paths: ReturnType<typeof bridgePaths>;
  /** in-memory, intentionally: a restart is itself a good reason to retry */
  private readonly attempts = new Map<string, number>();
  private channelToSlug = new Map<string, string>();
  private state: PersistedState = { version: 1, cursors: {}, questions: {}, paused: {}, channels: {} };
  private running = false;
  /**
   * The live project registry. Seeded from the injected config, then kept in
   * step with projects.yml by reloadProjects() — `slack-register` writes that
   * file, and the owner should not have to restart the daemon to make a newly
   * registered folder (or the office channel) work. (The ALLOWLIST stays
   * boot-only on purpose: it is the security boundary, and a boundary that
   * reloads from a file is a boundary anything that can write the file can
   * move.)
   */
  private projects: ProjectConfig[];
  /** exact last text of projects.yml — content, not mtime, so a same-size edit still counts */
  private projectsText: string | null = null;

  constructor(o: DaemonOptions) {
    this.tx = o.transport;
    this.cfg = o.config;
    this.projects = o.config.projects;
    this.nowFn = o.now ?? (() => Date.now());
    this.sink = o.log ?? (() => {});
    this.paths = bridgePaths(o.config.root);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await mkdir(this.paths.root, { recursive: true });
    await this.loadState();
    this.tx.onEvent((e) => this.onInbound(e));
    await this.tx.start();
    this.running = true;
    this.log("info", "daemon_started", {
      projects: this.projects.length,
      allowlist: this.cfg.allowedUserIds.length,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.saveState();
    await this.tx.stop();
  }

  /**
   * Resolve (creating if needed) every configured project's channel so that
   * inbound chat routes correctly even before the project has said anything.
   * Production only — tests assert on lazy creation.
   */
  async ensureAllChannels(): Promise<void> {
    // refresh:true deliberately bypasses the channel-id cache in state.json.
    // The id survives a change of Slack app; MEMBERSHIP does not. Re-running
    // ensureChannel is what calls conversations.join, so a daemon booted with a
    // new bot token rejoins the channels the old identity created instead of
    // failing every post with not_in_channel.
    for (const p of this.projects) {
      try { await this.channelIdFor(p.slug, { refresh: true }); }
      catch (err) { this.log("warn", "ensure_channel_failed", { project: p.slug, err: String(err) }); }
    }
  }

  // ------------------------------------------------------------ project registry

  /** the projects this daemon currently knows, in file order */
  projectSlugs(): string[] { return this.projects.map((p) => p.slug); }

  /** every Slack channel id this daemon currently routes — boot-time backfill's worklist. */
  slackChannels(): { slug: string; channel: string }[] {
    return [...this.channelToSlug.entries()].map(([channel, slug]) => ({ slug, channel }));
  }

  /**
   * Replay a historical inbound event (boot-time backfill only) through the
   * exact same pipeline a live one takes — allowlist check, pause commands,
   * thread-question settlement, inbox line shape, all of it. Never call this
   * for a live event; `onEvent` already wires those.
   */
  async backfillInbound(e: InboundEvent): Promise<void> {
    await this.onInbound(e);
  }

  /**
   * Everyone obeyed in THIS project's channel: the owners plus the project's
   * `admins:` from projects.yml. Admins are re-read with the file by
   * reloadProjects(), so adding/removing one needs no restart.
   */
  private allowedFor(slug: string): string[] {
    const owners = this.cfg.allowedUserIds;
    const admins = (this.projectFor(slug).admins ?? []).filter((id) => !owners.includes(id));
    return [...owners, ...admins];
  }

  private roleFor(slug: string, user: string): PersonRole {
    return this.cfg.allowedUserIds.includes(user) ? "owner" : "admin";
  }

  /** `from_name` + `role` for every inbox line written on behalf of a person */
  private async personFields(slug: string, user: string): Promise<{ from_name?: string; role: PersonRole }> {
    let name: string | undefined;
    try { name = await this.tx.resolveUserName(user); }
    catch (err) { this.log("warn", "resolve_name_failed", { user, err: String(err) }); }
    return { ...(name ? { from_name: name } : {}), role: this.roleFor(slug, user) };
  }

  /**
   * Re-read projects.yml when its content changed. Driven from pump(), which is
   * already woken by BOTH the fs.watch in index.ts and the 500ms poll — so a
   * missed watch event costs latency, never the update. No second watcher, no
   * new failure mode.
   */
  private async reloadProjects(): Promise<void> {
    let text: string;
    try { text = await readFile(this.paths.projectsFile, "utf8"); }
    catch { return; }                                     // no file: the injected config stands
    if (text === this.projectsText) return;
    this.projectsText = text;

    const parsed = daemonProjects(parseRegistry(text));
    // A writer caught mid-truncate reads as zero projects. Dropping the whole
    // registry because of a 200µs window would unroute every channel.
    if (parsed.length === 0 && this.projects.length > 0) {
      this.log("warn", "projects_reload_ignored", { why: "empty_file", kept: this.projects.length });
      return;
    }

    const before = new Set(this.projects.map((p) => p.slug));
    const added = parsed.map((p) => p.slug).filter((s) => !before.has(s));
    const changed = added.length > 0 || JSON.stringify(parsed) !== JSON.stringify(this.projects);
    this.projects = parsed;
    this.rebuildChannelMap();
    if (!changed) return;

    this.log("info", "projects_reloaded", { total: parsed.length, added });
    // Resolve the newcomers' channels now rather than on their first say, so
    // INBOUND chat routes to a freshly registered project (or the office) immediately.
    for (const slug of added) {
      try { await this.channelIdFor(slug); }
      catch (err) { this.log("warn", "reload_ensure_channel_failed", { project: slug, err: String(err) }); }
    }
  }

  // ------------------------------------------------------------------ outbound

  /** Read every project's outbox from its cursor and act on the new events. */
  async pump(): Promise<void> {
    await this.reloadProjects();
    for (const slug of await this.knownSlugs()) {
      const offset = this.state.cursors[slug] ?? 0;
      const { entries } = await readFrom<OutboxEvent>(this.paths.outbox(slug), offset);
      for (const { value, end } of entries) {
        try {
          await this.handleOutbox(slug, value);
        } catch (err) {
          const n = (this.attempts.get(value.id) ?? 0) + 1;
          this.attempts.set(value.id, n);
          this.log("error", "delivery_failed", { id: value.id, project: slug, attempt: n, err: String(err) });
          if (n < MAX_DELIVERY_ATTEMPTS) break;            // retry from this offset next pump
          await this.toInbox(slug, {
            ts: this.iso(), kind: "error", ref_id: value.id,
            reason: `delivery gave up after ${n} attempts`, detail: String(err),
          } satisfies ErrorLine);
        }
        this.attempts.delete(value.id);
        this.state.cursors[slug] = end;
        await this.saveState();
      }
    }
  }

  private async handleOutbox(slug: string, e: OutboxEvent): Promise<void> {
    if (e.kind === "say") return this.handleSay(slug, e);
    if (e.kind === "ask") return this.handleAsk(slug, e);
    if (e.kind === "reaction") return this.handleReaction(slug, e);
    return this.handleCancel(slug, e);
  }

  /**
   * The mechanical "I read this" ✅. `already_reacted` is swallowed inside the
   * transport (idempotent by construction — see SocketModeTransport.addReaction);
   * any other failure propagates to pump()'s existing retry-then-inbox-error
   * path, same as every other outbox kind. Never thrown past here uncaught in
   * a way that would stop the pump loop from moving on to the next project.
   */
  private async handleReaction(slug: string, e: ReactionEvent): Promise<void> {
    const tx = this.tx;
    if (!tx.addReaction) {
      await this.toInbox(slug, {
        ts: this.iso(), kind: "error", ref_id: e.id,
        reason: "reactions not supported by this transport",
      } satisfies ErrorLine);
      this.log("warn", "reaction_unsupported", { project: slug, id: e.id });
      return;
    }
    await tx.addReaction({ channel: e.channel, timestamp: e.slack_ts, name: e.name });
    this.log("info", "reaction_added", { project: slug, id: e.id, channel: e.channel, slack_ts: e.slack_ts });
  }

  private async handleSay(slug: string, e: SayEvent): Promise<void> {
    const paused = this.state.paused[slug];
    if (paused) {
      paused.suppressed += 1;
      this.log("info", "suppressed_while_paused", { project: slug, id: e.id, suppressed: paused.suppressed });
      return;
    }
    const channel = await this.channelIdFor(slug);
    const text = this.decorate(slug, e.text, e.urgent);
    const q = e.question_id ? this.state.questions[e.question_id] : undefined;
    if (e.file) return this.handleFileSay(slug, e, channel, text, q);
    if (q) return this.postInThread(q, text);
    await this.tx.postMessage({ channel, text });
  }

  /** `e.file` present: upload instead of chat.postMessage, `text` as the caption. */
  private async handleFileSay(
    slug: string, e: SayEvent, channel: string, text: string, q?: OpenQuestion,
  ): Promise<void> {
    const tx = this.tx;
    if (!tx.uploadFile) {
      await this.toInbox(slug, {
        ts: this.iso(), kind: "error", ref_id: e.id,
        reason: "file upload not supported by this transport",
      } satisfies ErrorLine);
      this.log("warn", "upload_unsupported", { project: slug, id: e.id });
      return;
    }
    await tx.uploadFile({
      channel, path: e.file!.path, title: e.file!.title, text,
      ...(q ? { threadTs: q.thread_ts } : {}),
    });
  }

  /** Post into a question's thread. */
  private async postInThread(q: OpenQuestion, text: string): Promise<void> {
    await this.tx.postMessage({ channel: q.channel, threadTs: q.thread_ts, text });
  }

  /**
   * The session says this question no longer applies. Forget it FIRST (so no
   * reminder / timeout default can fire even if the edit below fails), then
   * tell the owner by editing the buttons away in place.
   */
  private async handleCancel(slug: string, e: CancelEvent): Promise<void> {
    const q = this.state.questions[e.question_id];
    if (!q || q.project !== slug) {
      this.log("info", "cancel_unknown_question", { project: slug, question_id: e.question_id });
      return;
    }
    delete this.state.questions[e.question_id];
    await this.saveState();
    const note = TEXT.cancelled(e.reason);
    try {
      await this.tx.updateMessage({ channel: q.channel, ts: q.blocks_ts, text: note, blocks: settledBlocks(note) });
      if (q.header) {
        await this.tx.updateMessage({ channel: q.channel, ts: q.thread_ts, text: `${note}\n~${q.header}~` });
      }
    } catch (err) { this.log("warn", "cancel_notice_failed", { question_id: q.question_id, err: String(err) }); }
    this.log("info", "question_cancelled", { question_id: q.question_id, reason: e.reason });
  }

  private async handleAsk(slug: string, e: AskEvent): Promise<void> {
    // Validate up front. A question that can never resolve is a stall, and
    // §4.3 forbids silent stalls — so this fails at post time, loudly.
    if (e.on_timeout === "default" && e.timeout_ms !== null && (e.default === null || e.default === undefined)) {
      await this.toInbox(slug, {
        ts: this.iso(), kind: "error", ref_id: e.id,
        reason: "on_timeout=default requires an explicit --default",
      } satisfies ErrorLine);
      this.log("warn", "ask_rejected", { project: slug, question_id: e.question_id, why: "missing_default" });
      return;
    }
    if (this.state.paused[slug]) {
      await this.toInbox(slug, {
        ts: this.iso(), kind: "blocked", question_id: e.question_id, reason: "channel_paused",
        text: `#${this.projectFor(slug).channel} is paused — nobody will see this question. Say "resume" in the channel.`,
      } satisfies BlockedLine);
      this.log("warn", "ask_blocked_paused", { project: slug, question_id: e.question_id });
      return;
    }

    const tx = this.tx;
    const channel = await this.channelIdFor(slug);
    const header = this.questionHeader(slug, e);
    const parent = await tx.postMessage({ channel, text: header });

    // The interactive blocks live in a THREAD under the question.
    const blocks = await tx.postMessage({
      channel, threadTs: parent.ts,
      text: TEXT.blocksCarrier(),
      blocks: buildBlocks({ questionId: e.question_id, qtype: e.qtype, options: e.options }),
    });

    this.state.questions[e.question_id] = {
      question_id: e.question_id,
      project: slug,
      channel,
      thread_ts: parent.ts,
      header,
      blocks_ts: blocks.ts,
      qtype: e.qtype,
      options: e.options,
      default: e.default ?? null,
      on_timeout: e.on_timeout,
      expires_at: e.timeout_ms === null ? null : this.now() + e.timeout_ms,
      escalated: false,
    };
    await this.saveState();
    this.log("info", "question_posted", {
      project: slug, question_id: e.question_id, qtype: e.qtype,
    });
  }

  private questionHeader(slug: string, e: AskEvent): string {
    return TEXT.questionBody({
      text: this.decorate(slug, e.text, e.urgent),
      qtype: e.qtype,
      options: e.options,
      timeoutLabel: e.timeout_ms === null ? null : formatDuration(e.timeout_ms),
      default: e.default ?? null,
      onTimeout: e.on_timeout,
    });
  }

  private decorate(slug: string, text: string, urgent?: boolean): string {
    const owner = this.ownerFor();
    return urgent && owner ? `<@${owner}> ${text}` : text;
  }

  /** the first OWNER id (never an admin) — the person we @ when it is urgent */
  private ownerFor(): string | undefined { return this.cfg.allowedUserIds[0]; }

  // ------------------------------------------------------------------- inbound

  private async onInbound(e: InboundEvent): Promise<void> {
    // A stopped daemon must never write to an inbox. The real transport stops
    // delivering after disconnect(), but a handler can still be holding a
    // reference to us (hot restart in-process), and a double write would
    // duplicate the line the surviving daemon already recorded.
    if (!this.running) return;
    const slug = this.channelToSlug.get(e.channel);
    if (!slug) { this.log("warn", "unknown_channel", { channel: e.channel }); return; }
    if (e.type === "message" && e.isBot) return;                        // never echo ourselves
    if (!this.allowedFor(slug).includes(e.user)) {
      // Deliberately logs the user and channel only — never the payload text,
      // which is attacker-controlled and could carry a token-shaped string.
      this.log("warn", "not_allowlisted", { user: e.user, channel: e.channel, kind: e.type });
      return;
    }
    if (e.type === "message") return this.onMessage(slug, e.channel, e.user, e.text, e.ts, e.threadTs, e.files);
    if (e.type === "reaction_added" || e.type === "reaction_removed") return this.onReaction(slug, e);
    return this.onAction(slug, e as Extract<InboundEvent, { type: "action" }>);
  }

  /**
   * An allowlisted person reacted (or un-reacted) on a message. Intake only:
   * best-effort fetch the reacted message's text, then append the fact to the
   * inbox — never decide anything. What a given emoji means is the session's
   * business.
   */
  private async onReaction(slug: string, e: InboundReaction): Promise<void> {
    let text = "";
    if (this.tx.fetchMessageText) {
      try { text = (await this.tx.fetchMessageText(e.channel, e.itemTs)) ?? ""; }
      catch (err) { this.log("warn", "reaction_fetch_failed", { channel: e.channel, ts: e.itemTs, err: String(err) }); }
    }
    await this.toInbox(slug, {
      ts: this.iso(), kind: "reaction", action: e.type === "reaction_added" ? "added" : "removed",
      reactor: e.user, ...(await this.personFields(slug, e.user)), emoji: e.emoji,
      channel: e.channel, slack_ts: e.itemTs, text, event_ts: e.eventTs,
    });
  }

  private async onMessage(
    slug: string, channel: string, user: string, rawText: string, ts: string, threadTs?: string,
    files?: InboundFile[],
  ): Promise<void> {
    const text = rawText.trim();
    // A pure attachment (screenshot, no caption) still carries files — only an
    // empty message with nothing attached is nothing to report.
    if (!text && !(files && files.length)) return;

    if (!threadTs && PAUSE_CMD.test(text)) return this.onPauseCommand(slug, channel, text.toLowerCase());

    // A reply inside a question's thread is the only unambiguous case; a
    // message at channel level is just chat. A free-text question is answered
    // by its thread reply; every other qtype answers through its buttons.
    const q = threadTs ? this.questionByThread(threadTs) : undefined;
    if (q && q.qtype === "text") {
      await this.settle(q, { text, from: user, slackTs: ts });
      return;
    }
    const resolved = files && files.length ? await this.downloadFiles(slug, ts, files) : undefined;
    await this.toInbox(slug, {
      ts: this.iso(), kind: "message", from: user, ...(await this.personFields(slug, user)),
      text, channel, slack_ts: ts,
      ...(q ? { question_id: q.question_id } : {}),
      ...(resolved ? { files: resolved } : {}),
    } as MessageLine & { question_id?: string });
  }

  /**
   * Download every attachment on one inbound message into
   * `~/.liaison/<slug>/files/<slack_ts>-<sanitized name>`. Each file is
   * independent: one bad download produces one `{ error }` entry, never a
   * thrown error that would drop the whole message (and never the token in
   * that error — see `tx.downloadFile`, which is the only thing that touches it).
   */
  private async downloadFiles(slug: string, slackTs: string, files: InboundFile[]): Promise<InboxFileRef[]> {
    const tx = this.tx;
    const dir = this.paths.filesDir(slug);
    const out: InboxFileRef[] = [];
    for (const f of files) {
      const base: InboxFileRef = { id: f.id, name: f.name, mimetype: f.mimetype, size: f.size };
      const url = f.urlPrivateDownload ?? f.urlPrivate;
      if (!url || !tx.downloadFile) {
        out.push({ ...base, error: "download not supported for this transport" });
        continue;
      }
      try {
        const buf = await tx.downloadFile(url);
        await mkdir(dir, { recursive: true });
        // Never overwrite: same-named attachments (e.g. three "image.png") get
        // `<ts>-<n>-<name>`; "wx" makes the existence check atomic.
        const safe = sanitizeFileName(f.name);
        let path = "";
        for (let n = 1; ; n++) {
          path = join(dir, n === 1 ? `${slackTs}-${safe}` : `${slackTs}-${n}-${safe}`);
          try { await writeFile(path, buf, { flag: "wx" }); break; }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        }
        out.push({ ...base, path });
      } catch (err) {
        this.log("warn", "file_download_failed", { project: slug, file: f.id, err: String(err) });
        out.push({ ...base, error: String(err) });
      }
    }
    return out;
  }

  private async onAction(slug: string, e: Extract<InboundEvent, { type: "action" }>): Promise<void> {
    const decoded = e.value ? decodeValue(e.value) : null;
    const q = (decoded ? this.state.questions[decoded.q] : undefined)
      ?? (e.threadTs ? this.questionByThread(e.threadTs) : undefined);
    if (!q) { this.log("warn", "unknown_question", { channel: e.channel, action: e.actionId }); return; }

    if (e.actionId === ACTION_MULTI) {
      q.pending_choices = e.blockState?.[ACTION_MULTI] ?? [];
      await this.saveState();
      return;
    }
    if (e.actionId === ACTION_SUBMIT) {
      const choices = (e.blockState?.[ACTION_MULTI] ?? q.pending_choices ?? []).filter(Boolean);
      if (choices.length === 0) {
        await this.postInThread(q, TEXT.needSelection());
        return;
      }
      await this.settle(q, { choices, from: e.user, slackTs: e.ts });
      return;
    }
    if (!isChoiceAction(e.actionId)) { this.log("warn", "unknown_action", { action: e.actionId }); return; }
    if (!decoded) { this.log("warn", "undecodable_action", { action: e.actionId }); return; }
    await this.settle(q, { choice: decoded.o, from: e.user, slackTs: e.ts });
  }

  private async onPauseCommand(slug: string, channel: string, cmd: string): Promise<void> {
    const text = TEXT;
    const tx = this.tx;
    if (cmd === "pause") {
      // Confirm BEFORE flipping the flag, so the acknowledgement itself is not suppressed.
      await tx.postMessage({ channel, text: text.paused() });
      this.state.paused[slug] = { since: this.now(), suppressed: 0 };
      this.log("info", "paused", { project: slug });
    } else {
      const n = this.state.paused[slug]?.suppressed ?? 0;
      delete this.state.paused[slug];
      await tx.postMessage({ channel, text: text.resumed(n) });
      this.log("info", "resumed", { project: slug, suppressed: n });
    }
    await this.saveState();
  }

  // ------------------------------------------------------------------ settling

  private async settle(
    q: OpenQuestion,
    a: { choice?: string; choices?: string[]; text?: string; from: string; slackTs: string; viaTimeout?: boolean },
  ): Promise<void> {
    const timeout = a.viaTimeout === true;
    const person = timeout ? undefined : await this.personFields(q.project, a.from);
    const name = timeout ? "system:timeout" : person?.from_name ?? a.from;
    const line: AnswerLine = {
      ts: this.iso(),
      kind: "answer",
      question_id: q.question_id,
      from: timeout ? "system" : a.from,
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.choice !== undefined ? { choice: a.choice } : {}),
      ...(a.choices !== undefined ? { choices: a.choices } : {}),
      channel: q.channel,
      slack_ts: a.slackTs,
      answered_by: name,
      via: timeout ? "timeout-default" : "slack",
      // An admin's answer carries the owner's authority; WHO decided stays
      // visible in executed_by + role.
      executed_by: name,
      authority: timeout ? "system-default" : "owner-decision",
      ...(person ? person : {}),
    };
    delete this.state.questions[q.question_id];
    await this.toInbox(q.project, line);
    await this.saveState();

    // ---- the ACK: EXACTLY ONE per settled question, every qtype.
    // Not decoration — it is the owner's only evidence that the thing they typed
    // was understood as they meant it and reached the session. It quotes the
    // value back, so a misparse is visible immediately rather than at the end of
    // the work. Best-effort, and AFTER the inbox line: the answer is already
    // recorded, so a failure to decorate the channel must never look like a lost
    // answer.
    const value = a.choice ?? a.choices?.join(", ") ?? a.text ?? "";
    const summary = timeout ? TEXT.timeoutSummary(value) : TEXT.settledSummary(value, name);
    try {
      // The ack REPLACES the interactive blocks in place. One message, not two,
      // and the buttons die in the same stroke.
      await this.tx.updateMessage({
        channel: q.channel, ts: q.blocks_ts, text: summary, blocks: settledBlocks(summary),
      });
    } catch (err) { this.log("warn", "settle_ack_failed", { question_id: q.question_id, err: String(err) }); }
    this.log("info", "question_settled", { question_id: q.question_id, via: line.via });
  }

  // -------------------------------------------------------------------- timers

  /** Expire questions whose deadline has passed  */
  async tick(nowMs?: number): Promise<void> {
    const now = nowMs ?? this.now();
    for (const q of Object.values(this.state.questions)) {
      if (q.expires_at === null || now < q.expires_at) continue;

      const text = TEXT;

      if (q.on_timeout === "escalate") {
        if (q.escalated) continue;
        q.escalated = true;
        await this.saveState();
        const owner = this.ownerFor();
        const mention = owner ? `<@${owner}> ` : "";
        await this.postInThread(q, text.escalate(mention));
        this.log("info", "question_escalated", { question_id: q.question_id });
        continue;
      }

      if (q.on_timeout === "block") {
        delete this.state.questions[q.question_id];
        await this.toInbox(q.project, {
          ts: this.iso(), kind: "blocked", question_id: q.question_id, reason: "timeout_block",
          text: "no answer before the deadline and no default was allowed — work is blocked",
          channel: q.channel, slack_ts: q.thread_ts,
        } satisfies BlockedLine);
        await this.saveState();
        await this.postInThread(q, text.timeoutBlocked());
        this.log("warn", "question_blocked", { question_id: q.question_id });
        continue;
      }

      // on_timeout === "default"
      const value = q.default ?? "";
      await this.settle(q, { choice: value, from: "system", slackTs: q.thread_ts, viaTimeout: true });
      await this.postInThread(q, text.timeoutApplied(value));
    }
  }

  // --------------------------------------------------------------- inspection

  openQuestions(): OpenQuestion[] { return Object.values(this.state.questions); }
  isPaused(slug: string): boolean { return this.state.paused[slug] !== undefined; }
  isRunning(): boolean { return this.running; }

  // ------------------------------------------------------------------ helpers

  private now(): number { return this.nowFn(); }
  private iso(): string { return new Date(this.now()).toISOString(); }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    const r: LogRecord = fields ? { level, msg, fields } : { level, msg };
    this.logs.push(r);
    this.sink(r);
  }

  private questionByThread(threadTs: string): OpenQuestion | undefined {
    return Object.values(this.state.questions).find((q) => q.thread_ts === threadTs);
  }

  private projectFor(slug: string): ProjectConfig {
    return this.projects.find((p) => p.slug === slug) ?? { slug, channel: channelForSlug(slug), paths: [] };
  }

  private async channelIdFor(slug: string, o: { refresh?: boolean } = {}): Promise<string> {
    const project = this.projectFor(slug);
    const name = project.channel;
    const cached = this.state.channels[name];
    if (cached && !o.refresh) { this.channelToSlug.set(cached, slug); return cached; }
    const ref = await this.tx.ensureChannel(name);
    this.state.channels[name] = ref.id;
    this.channelToSlug.set(ref.id, slug);
    await this.saveState();
    if (ref.created) {
      this.log("info", "channel_created", { project: slug, channel: name });
      // A bot-created channel contains only the bot. Without this the owner is
      // not a member, the channel never appears in their sidebar, and every
      // question goes to an empty room — which is exactly what happened on
      // in the first live run.
      const allowed = this.allowedFor(slug);
      if (allowed.length > 0) {
        try {
          await this.tx.inviteUsers(ref.id, allowed);
          this.log("info", "owner_invited", { project: slug, channel: name, count: allowed.length });
        } catch (err) {
          // Never fatal: a channel we cannot invite into is still a channel we
          // can post to, and the owner can join by hand.
          this.log("warn", "invite_failed", { project: slug, channel: name, err: String(err) });
        }
      }
    }
    return ref.id;
  }

  /** Configured projects plus any project directory that already exists. */
  private async knownSlugs(): Promise<string[]> {
    const slugs = new Set(this.projects.map((p) => p.slug));
    try {
      for (const d of await readdir(this.paths.root, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "logs") slugs.add(d.name);
      }
    } catch { /* root not created yet */ }
    return [...slugs];
  }

  private async toInbox(slug: string, line: InboxLine): Promise<void> {
    await appendLine(this.paths.inbox(slug), line);
  }

  private async loadState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.stateFile, "utf8")) as PersistedState;
      this.state = {
        version: 1,
        cursors: parsed.cursors ?? {},
        questions: parsed.questions ?? {},
        paused: parsed.paused ?? {},
        channels: parsed.channels ?? {},
      };
    } catch { /* first boot */ }
    this.rebuildChannelMap();
  }

  /** channel id -> project slug, for every channel whose id we already know. */
  private rebuildChannelMap(): void {
    this.channelToSlug = new Map();
    for (const p of this.projects) {
      const id = this.state.channels[p.channel];
      if (id) this.channelToSlug.set(id, p.slug);
    }
    for (const [name, id] of Object.entries(this.state.channels)) {
      if (!this.channelToSlug.has(id) && name.startsWith("liaison-")) this.channelToSlug.set(id, name.slice("liaison-".length));
    }
  }

  /** Atomic: write a temp file then rename, so a crash never leaves half a state. */
  private async saveState(): Promise<void> {
    await mkdir(this.paths.root, { recursive: true });
    const tmp = join(this.paths.root, `.state.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.paths.stateFile);
  }
}
