// ---------------------------------------------------------------------------
// backfill.ts — boot-time recovery for the Socket Mode zombie-websocket
// incident: the inbound socket stopped delivering events while REST sends kept
// working and the service manager never saw an exit, so anything the owner
// said during that window never reached any inbox.
//
// On every boot (not just after a crash — a normal restart has the same gap
// between "process down" and "process up") this fetches each Slack channel's
// own history since OUR OWN cursor (never a consumer's `.cursor.<reader>`
// file — those are inbox read positions for sessions, not the daemon's own
// catch-up point) and replays anything not already in that project's
// inbox.jsonl through the SAME onInbound pipeline a live event takes, so the
// inbox line it produces is indistinguishable from one written live.
// ---------------------------------------------------------------------------
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Daemon, LogRecord } from "./daemon.ts";
import { readLines } from "./jsonl.ts";
import { bridgePaths } from "./paths.ts";
import type { SlackTransport } from "./transport.ts";
import type { InboxLine } from "./types.ts";

/** Cap on how far back a cold cursor (first boot, or one older than this) will reach. */
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Politeness delay between channels — this runs once at boot, never on the hot path. */
const CHANNEL_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCursor(file: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { lastTs?: string };
    return raw.lastTs || undefined;
  } catch { return undefined; }
}

/** Atomic: a crash mid-write must never leave a cursor file tsc can't parse. */
async function writeCursor(file: string, ts: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ lastTs: ts }), "utf8");
  await rename(tmp, file);
}

export interface BackfillOptions {
  daemon: Daemon;
  transport: SlackTransport;
  root: string;
  log: (r: LogRecord) => void;
  now?: () => number;
}

/** slack_ts values already in a project's inbox.jsonl, and the newest one (numeric max, as a string). */
async function readSeen(paths: ReturnType<typeof bridgePaths>, slug: string): Promise<{ seen: Set<string>; newest: string | undefined }> {
  try {
    const lines = await readLines<InboxLine>(paths.inbox(slug));
    const tss = lines.flatMap((l) => ("slack_ts" in l && l.slack_ts ? [l.slack_ts] : []));
    const newest = tss.reduce<string | undefined>((best, t) => (best === undefined || Number(t) > Number(best) ? t : best), undefined);
    return { seen: new Set(tss), newest };
  } catch { return { seen: new Set(), newest: undefined }; }
}

/**
 * Run once at boot, after `daemon.ensureAllChannels()` (channelToSlug must be
 * populated) and before the pump/tick timers start. Never throws — a failure
 * for one project must not block another, and must never block the daemon
 * from starting to serve live traffic.
 */
export async function backfillOnBoot(o: BackfillOptions): Promise<void> {
  if (!o.transport.fetchHistory) return; // this provider/scope cannot list history — nothing to do
  const now = o.now ?? (() => Date.now());
  const paths = bridgePaths(o.root);

  for (const { slug, channel } of o.daemon.slackChannels()) {
    const cursorFile = paths.bridgeCursor(slug);
    const floor = String((now() - BACKFILL_WINDOW_MS) / 1000);
    const cursorRaw = await readCursor(cursorFile);
    const { seen, newest } = await readSeen(paths, slug);

    let oldest: string;
    if (cursorRaw) {
      // A real cursor from a PRIOR backfill run. Still capped at the 24h
      // floor — a daemon down for a week must not replay a week.
      oldest = Number(cursorRaw) > Number(floor) ? cursorRaw : floor;
    } else {
      // No cursor yet — this is either a brand-new project (nothing in
      // inbox.jsonl: nothing to catch up on, start the clock at "now") or an
      // already-running one whose cursor predates this feature (something IS
      // in inbox.jsonl: trust it, and never blind-replay the 24h floor below
      // whatever that project has already delivered — that would re-trigger
      // old questions/answers in every gap inbox.jsonl happens to have).
      // Persisted immediately so a crash before fetchHistory below returns
      // does not fall back to this computation (and the 24h floor) again.
      oldest = newest ?? String(now() / 1000);
      await writeCursor(cursorFile, oldest);
    }

    let msgs: Awaited<ReturnType<NonNullable<SlackTransport["fetchHistory"]>>>;
    try {
      msgs = await o.transport.fetchHistory(channel, oldest);
    } catch (err) {
      o.log({ level: "warn", msg: "backfill_fetch_failed", fields: { project: slug, channel, err: String(err) } });
      await sleep(CHANNEL_DELAY_MS);
      continue;
    }

    let delivered = 0;
    let skipped = 0;
    for (const m of msgs) {
      // Re-read, not just the snapshot taken above: a live message can land
      // in inbox.jsonl WHILE this loop awaits backfillInbound for another
      // one (the socket is already running by the time backfill runs). A
      // snapshot-only check would risk replaying something the live path
      // just delivered a moment ago.
      const live = await readSeen(paths, slug);
      if (seen.has(m.ts) || live.seen.has(m.ts)) { skipped++; }
      else {
        try { await o.daemon.backfillInbound(m); delivered++; }
        catch (err) {
          o.log({ level: "warn", msg: "backfill_replay_failed", fields: { project: slug, ts: m.ts, err: String(err) } });
        }
      }
      // Advance regardless of outcome: a message this daemon has SEEN (even
      // if it chose not to write it — not-allowlisted, empty text, a pause
      // command) must never be fetched and re-evaluated on the next boot.
      await writeCursor(cursorFile, m.ts);
    }
    if (msgs.length > 0) {
      o.log({ level: "info", msg: "backfill_done", fields: { project: slug, channel, fetched: msgs.length, delivered, skipped } });
    }
    await sleep(CHANNEL_DELAY_MS);
  }
}
