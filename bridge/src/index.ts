#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// index.ts — the daemon entrypoint. This is the only place that reads tokens,
// and it reads them from disk at BOOT ONLY. Restart the daemon to pick up a
// changed allowlist or a rotated token.
//
// Token resolution (highest precedence first), values NEVER logged:
//   1. the process environment   LIAISON_BOT_TOKEN / LIAISON_APP_TOKEN
//   2. ~/.liaison/.env           the same keys
//   3. $LIAISON_FALLBACK_ENV     the same keys, when that variable is set
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { Daemon, type LogRecord } from "./daemon.ts";
import { backfillOnBoot } from "./backfill.ts";
import { FakeTransport } from "./fake-transport.ts";
import { FakeFileBridge } from "./fake-runner.ts";
import { SocketModeTransport } from "./socket-transport.ts";
import { bridgePaths } from "./paths.ts";
import { daemonProjects, parseEnvFile, parseRegistry, type DaemonConfig } from "./config.ts";
import type { SlackTransport } from "./transport.ts";

const PUMP_MS = Number(process.env["LIAISON_PUMP_MS"] ?? 500);
const TICK_MS = Number(process.env["LIAISON_TICK_MS"] ?? 1000);
/** an external supervisor can check the freshness of the heartbeat log line below. */
const HEARTBEAT_MS = Number(process.env["LIAISON_HEARTBEAT_MS"] ?? 60_000);

function log(r: LogRecord): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...r }) + "\n");
}

async function readIfPresent(file: string): Promise<Record<string, string>> {
  try { return parseEnvFile(await readFile(file, "utf8")); } catch { return {}; }
}

export async function loadRuntimeEnv(root: string): Promise<Record<string, string>> {
  const own = await readIfPresent(bridgePaths(root).envFile);
  const fallbackPath = process.env["LIAISON_FALLBACK_ENV"];
  const fallback = fallbackPath ? await readIfPresent(fallbackPath) : {};
  return { ...fallback, ...own, ...process.env as Record<string, string> };
}

function pick(env: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) { const v = env[k]; if (v) return v; }
  return undefined;
}

async function main(): Promise<void> {
  // Registered FIRST, before any await: a zombie websocket leaves the process
  // alive with a dead inbound path and REST sends still working —
  // silently-still-running, nothing left actually working. An unhandled
  // rejection or thrown exception anywhere (boot included) is the same shape
  // of failure, so it gets the same answer: log loud, exit, and let the
  // service manager restart us into a clean state.
  process.on("unhandledRejection", (reason) => {
    log({ level: "error", msg: "unhandled_rejection", fields: { err: String(reason) } });
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    log({ level: "error", msg: "uncaught_exception", fields: { err: String(err) } });
    process.exit(1);
  });

  const root = process.env["LIAISON_ROOT"] ?? bridgePaths().root;
  const paths = bridgePaths(root);
  const env = await loadRuntimeEnv(root);
  const fake = process.env["LIAISON_FAKE"] === "1";

  const projects = daemonProjects(parseRegistry(await readFile(paths.projectsFile, "utf8").catch(() => "")));
  const allowed = (pick(env, "LIAISON_OWNER_USER_IDS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (allowed.length === 0) {
    log({ level: "warn", msg: "empty_allowlist", fields: { hint: "set LIAISON_OWNER_USER_IDS — the daemon obeys nobody until you do" } });
  }

  let transport: SlackTransport;
  let bridge: FakeFileBridge | undefined;
  if (fake) {
    const tx = new FakeTransport();
    for (const id of allowed) tx.userNames.set(id, "owner");
    bridge = new FakeFileBridge(tx, root);
    transport = tx;
    log({ level: "warn", msg: "fake_transport", fields: { root, hint: "no Slack connection — smoke mode" } });
  } else {
    const botToken = pick(env, "LIAISON_BOT_TOKEN");
    const appToken = pick(env, "LIAISON_APP_TOKEN");
    if (!botToken || !appToken) {
      log({ level: "error", msg: "missing_tokens", fields: { looked_in: [paths.envFile, process.env["LIAISON_FALLBACK_ENV"] ?? "(LIAISON_FALLBACK_ENV unset)"] } });
      process.exit(1);
    }
    transport = new SocketModeTransport({
      botToken, appToken,
      log: (msg, fields) => log({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    });
  }

  const config: DaemonConfig = {
    root, allowedUserIds: allowed, projects, dryRun: false,
  };
  const daemon = new Daemon({ transport, config, log });
  await daemon.start();
  if (transport instanceof SocketModeTransport && transport.identity) {
    log({ level: "info", msg: "slack_identity", fields: transport.identity });
  }
  if (!fake) await daemon.ensureAllChannels();

  // Recover whatever a dead-inbound-socket window (zombie websocket, or any
  // other gap between "process down" and "process up") missed. Never fatal:
  // a backfill failure must not block live traffic from starting.
  if (!fake) {
    try { await backfillOnBoot({ daemon, transport, root, log }); }
    catch (err) { log({ level: "error", msg: "backfill_failed", fields: { err: String(err) } }); }
  }

  let busy = false;
  const cycle = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      if (bridge) await bridge.poll();
      await daemon.pump();
    } catch (err) {
      log({ level: "error", msg: "pump_failed", fields: { err: String(err) } });
    } finally { busy = false; }
  };

  const pumpTimer = setInterval(() => void cycle(), PUMP_MS);
  const tickTimer = setInterval(() => void daemon.tick().catch((err) => log({ level: "error", msg: "tick_failed", fields: { err: String(err) } })), TICK_MS);
  // A heartbeat on the event loop itself, independent of inbound Slack
  // traffic (channels are legitimately idle for hours). A supervisor can read
  // THIS line's freshness, not inbox activity, to tell "alive and pumping"
  // apart from "process up, event loop stuck". A zombie websocket would NOT
  // show here (the loop keeps running); the socket-liveness exit(1) handles
  // that case, this one covers a stuck event loop.
  const heartbeatTimer = setInterval(
    () => log({ level: "info", msg: "heartbeat", fields: { uptime_s: Math.round(process.uptime()) } }),
    HEARTBEAT_MS,
  );

  // fs.watch is a latency optimisation on top of the poll, never the only path:
  // if the watch misses an event (it does, on some volumes) the poll still gets it.
  let watcher: ReturnType<typeof watch> | undefined;
  try { watcher = watch(root, { recursive: true }, () => void cycle()); }
  catch (err) { log({ level: "warn", msg: "watch_unavailable", fields: { err: String(err) } }); }

  log({ level: "info", msg: "ready", fields: {
    root, projects: projects.length, fake,
  } });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ level: "info", msg: "shutting_down", fields: { signal } });
    clearInterval(pumpTimer);
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    watcher?.close();
    await daemon.stop();
    log({ level: "info", msg: "stopped" });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) await main();
