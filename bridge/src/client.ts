// ---------------------------------------------------------------------------
// client.ts — the session-side half of the protocol: what bin/slack-say and
// bin/slack-ask do. It writes ONE line and returns. It never opens a socket,
// never holds a token, and never waits for the daemon. That is the whole point:
// the thing that waits is the daemon, not the session.
// ---------------------------------------------------------------------------
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskEvent, CancelEvent, InboxLine, OnTimeout, QuestionType, SayEvent } from "./types.ts";
import { appendLine, readFrom, readLines } from "./jsonl.ts";
import { bridgePaths } from "./paths.ts";
import { parseDuration } from "./duration.ts";
import { resolveProject, type ResolvedProject } from "./config.ts";
import { readRegistry } from "./register.ts";
import { newId } from "./ids.ts";

export interface SayArgs {
  root?: string; cwd?: string; text: string; urgent?: boolean; questionId?: string;
  /** upload this local file; `text` becomes its caption (may be empty) */
  file?: { path: string; title?: string };
}
export interface AskArgs {
  root?: string; cwd?: string; text: string;
  type: QuestionType; options?: string[];
  timeout?: string | null; default?: string | null; onTimeout?: OnTimeout; urgent?: boolean;
}

const CHOICE_TYPES: QuestionType[] = ["buttons", "select", "multiselect"];

/**
 * cwd -> where it talks (READ path): the registered project that claims the
 * path, else the office. Throws OfficeNotConfigured when neither exists. Reads
 * projects.yml and writes NOTHING — only `slack-register` registers.
 */
export async function routeFor(root: string, cwd: string): Promise<ResolvedProject> {
  return resolveProject(await readRegistry(bridgePaths(root).projectsFile), cwd);
}

export async function projectSlug(root: string, cwd: string): Promise<string> {
  return (await routeFor(root, cwd)).slug;
}

/**
 * The written outbox line is a pure SayEvent; `registered` rides back on the
 * returned object only, so a verb can tell the session the folder fell through
 * to the office channel without putting that in the protocol.
 */
export type Said = SayEvent & { registered: boolean; inOffice: boolean };
export type Asked = AskEvent & { registered: boolean; inOffice: boolean };

export async function say(a: SayArgs): Promise<Said> {
  const root = a.root ?? bridgePaths().root;
  const cwd = a.cwd ?? process.cwd();
  // A file upload's caption may be empty — only a bare text-only say needs text.
  if (!a.file && !a.text.trim()) throw new Error("nothing to say — pass some text");
  const route = await routeFor(root, cwd);
  const slug = route.slug;
  const e: SayEvent = {
    id: newId("say"),
    ts: new Date().toISOString(),
    kind: "say",
    project: slug,
    text: a.text,
    ...(a.urgent ? { urgent: true } : {}),
    ...(a.questionId ? { question_id: a.questionId } : {}),
    ...(a.file ? { file: a.file } : {}),
  };
  await appendLine(bridgePaths(root).outbox(slug), e);
  return { ...e, registered: route.registered, inOffice: route.inOffice };
}

export async function ask(a: AskArgs): Promise<Asked> {
  const root = a.root ?? bridgePaths().root;
  const cwd = a.cwd ?? process.cwd();
  if (a.type === "yesno" && (a.options ?? []).length > 0) {
    throw new Error("--options given but --type is yesno; pass --type buttons");
  }
  const options = a.type === "yesno" ? ["yes", "no"] : (a.options ?? []);

  // Validate BEFORE writing. A malformed question that reaches the daemon is a
  // question the session then waits on forever.
  if (CHOICE_TYPES.includes(a.type) && options.length === 0) {
    throw new Error(`--type ${a.type} needs --options "A,B,C"`);
  }
  if (a.default !== null && a.default !== undefined && a.type !== "text" && !options.includes(a.default)) {
    throw new Error(`--default ${JSON.stringify(a.default)} is not one of the options (${options.join(", ")})`);
  }
  const timeoutMs = a.timeout === null || a.timeout === undefined || a.timeout === "" ? null : parseDuration(a.timeout);
  // No timeout means nothing can expire, so escalate is the only honest default.
  const onTimeout: OnTimeout = a.onTimeout ?? (timeoutMs === null ? "escalate" : (a.default != null ? "default" : "escalate"));
  if (onTimeout === "default" && timeoutMs !== null && (a.default === null || a.default === undefined)) {
    throw new Error("--on-timeout default requires --default <option>");
  }

  const route = await routeFor(root, cwd);
  const slug = route.slug;
  const e: AskEvent = {
    id: newId("ask"),
    ts: new Date().toISOString(),
    kind: "ask",
    project: slug,
    question_id: newId("q"),
    text: a.text,
    qtype: a.type,
    options,
    timeout_ms: timeoutMs,
    default: a.default ?? null,
    on_timeout: onTimeout,
    ...(a.urgent ? { urgent: true } : {}),
  };
  await appendLine(bridgePaths(root).outbox(slug), e);
  return { ...e, registered: route.registered, inOffice: route.inOffice };
}

/**
 * Drain inbox lines this reader has not seen. Cursors are per-reader so a
 * Monitor and a manual `slack-inbox` do not eat each other's events.
 */
export async function drainInbox(a: { root?: string; cwd?: string; reader?: string; all?: boolean } = {}): Promise<InboxLine[]> {
  const root = a.root ?? bridgePaths().root;
  const cwd = a.cwd ?? process.cwd();
  const slug = await projectSlug(root, cwd);
  const p = bridgePaths(root);
  const file = p.inbox(slug);
  if (a.all) return (await readFrom<InboxLine>(file, 0)).entries.map((x) => x.value);

  const reader = (a.reader ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  const cursorFile = join(p.projectDir(slug), `.cursor.${reader}`);
  let offset = 0;
  try { offset = Number(await readFile(cursorFile, "utf8")) || 0; } catch { /* first read */ }
  const { entries, offset: next } = await readFrom<InboxLine>(file, offset);
  await mkdir(p.projectDir(slug), { recursive: true });
  await writeFile(cursorFile, String(next), "utf8");
  return entries.map((x) => x.value);
}

// --------------------------------------------------------------------- ack

/**
 * Best-effort channel id lookup for `bin/slack-ack` when `--channel` is
 * omitted — "resolved from cwd like slack-say". Read-only, three fallbacks in
 * order: (1) the channel name this folder routes to (its registered project,
 * else the office), looked up in the daemon's own
 * state.json channel cache; (2) failing that, the most recent `channel` value
 * seen in this project's own inbox (a message really did arrive from
 * somewhere); (3) undefined — the caller must ask for `--channel` explicitly.
 * Never writes anything, never contacts Slack.
 */
export async function resolveChannelId(root: string, cwd: string): Promise<string | undefined> {
  const { slug, channel: channelName } = await routeFor(root, cwd);

  try {
    const raw = JSON.parse(await readFile(bridgePaths(root).stateFile, "utf8")) as { channels?: Record<string, string> };
    const id = raw.channels?.[channelName];
    if (id) return id;
  } catch { /* daemon has not booted / saved state yet */ }

  try {
    const lines = await readLines<InboxLine>(bridgePaths(root).inbox(slug));
    for (let i = lines.length - 1; i >= 0; i--) {
      const ch = (lines[i] as { channel?: string }).channel;
      if (ch) return ch;
    }
  } catch { /* no inbox yet */ }

  return undefined;
}

// ------------------------------------------------------------ cancel / open

export interface OpenQ { question_id: string; text: string; ts: string; ageMin: number }

export class CancelError extends Error {}

/**
 * This project's questions that are still open, derived from the files alone:
 * every `ask` in the outbox, minus those cancelled (outbox `cancel`), answered
 * or blocked (inbox), or rejected by the daemon (inbox `error` for the ask id).
 * Read-only — registers nothing.
 */
export async function openQuestions(a: { root?: string; cwd?: string; slug?: string; now?: number; } = {}): Promise<OpenQ[]> {
  const root = a.root ?? bridgePaths().root;
  const slug = a.slug ?? await projectSlug(root, a.cwd ?? process.cwd());
  const p = bridgePaths(root);
  const out = await readLines<{ kind?: string; id?: string; ts?: string; question_id?: string; text?: string }>(p.outbox(slug)).catch(() => []);
  const inb = await readLines<{ kind?: string; question_id?: string; ref_id?: string }>(p.inbox(slug)).catch(() => []);
  const closed = new Set<string>();
  const rejected = new Set<string>();
  for (const l of out) if (l.kind === "cancel" && l.question_id) closed.add(l.question_id);
  for (const l of inb) {
    if ((l.kind === "answer" || l.kind === "blocked") && l.question_id) closed.add(l.question_id);
    if (l.kind === "error" && l.ref_id) rejected.add(l.ref_id);
  }
  const now = a.now ?? Date.now();
  return out
    .filter((l) => l.kind === "ask" && l.question_id && !closed.has(l.question_id) && !rejected.has(l.id ?? ""))
    .map((l) => ({
      question_id: l.question_id!, text: l.text ?? "", ts: l.ts ?? "",
      ageMin: Math.max(0, Math.floor((now - Date.parse(l.ts ?? "")) / 60_000) || 0),
    }));
}

export const DEFAULT_CANCEL_REASON = "replaced or resolved in conversation";

/** Queue a `cancel` for one of THIS project's open questions. Throws CancelError (CLI exit 2) otherwise; writes nothing then. */
export async function cancelQuestion(a: { root?: string; cwd?: string; questionId: string; reason?: string}): Promise<CancelEvent> {
  const root = a.root ?? bridgePaths().root;
  const cwd = a.cwd ?? process.cwd();
  const slug = await projectSlug(root, cwd);
  const open = await openQuestions({ root, slug });
  if (!open.some((q) => q.question_id === a.questionId)) {
    throw new CancelError(`slack-ask: no open question "${a.questionId}" in project ${slug} (it does not exist, was already answered, or was already cancelled). Nothing was sent. List open ones: slack-ask --open`);
  }
  const e: CancelEvent = {
    id: newId("cancel"), ts: new Date().toISOString(), kind: "cancel", project: slug,
    question_id: a.questionId, reason: a.reason?.trim() || DEFAULT_CANCEL_REASON,
  };
  await appendLine(bridgePaths(root).outbox(slug), e);
  return e;
}
