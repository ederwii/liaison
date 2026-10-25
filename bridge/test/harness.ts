import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { FakeTransport } from "../src/fake-transport.ts";
import type { DaemonConfig } from "../src/config.ts";
import type { OutboxEvent, ProjectConfig } from "../src/types.ts";

export const OWNER = "U_OWNER";
export const INTRUDER = "U_RANDO";
export const T0 = 1_700_000_000_000;

export interface Rig {
  root: string;
  tx: FakeTransport;
  daemon: Daemon;
  clock: { t: number };
  cleanup(): void;
  /** append an event straight to a project outbox (bypasses bin/ scripts) */
  push(slug: string, e: Partial<OutboxEvent> & { kind: OutboxEvent["kind"] }): OutboxEvent;
  inbox(slug: string): any[];
  outboxPath(slug: string): string;
  inboxPath(slug: string): string;
}

let counter = 0;

export function makeRig(opts: { projects?: ProjectConfig[]; allowed?: string[] } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "liaison-test-"));
  const projects: ProjectConfig[] = opts.projects ?? [
    { slug: "alpha", channel: "liaison-alpha", paths: ["/home/me/alpha-v2"] },
    { slug: "beta", channel: "liaison-beta", paths: ["/home/me/beta"] },
  ];
  for (const p of projects) mkdirSync(join(root, p.slug), { recursive: true });

  const tx = new FakeTransport();
  tx.userNames.set(OWNER, "Owner");
  const clock = { t: T0 };
  const config: DaemonConfig = {
    root,
    allowedUserIds: opts.allowed ?? [OWNER],
    projects,
    dryRun: false,
  };
  const daemon = new Daemon({ transport: tx, config, now: () => clock.t });

  const rig: Rig = {
    root, tx, daemon, clock,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    outboxPath: (slug) => join(root, slug, "outbox.jsonl"),
    inboxPath: (slug) => join(root, slug, "inbox.jsonl"),
    push(slug, e) {
      counter += 1;
      const base = { id: `evt_${counter}`, ts: new Date(clock.t).toISOString(), project: slug };
      const full = (e.kind === "ask"
        ? { ...base, question_id: `q_${counter}`, text: "?", qtype: "buttons",
            options: [], timeout_ms: null, default: null, on_timeout: "default", ...e }
        : { ...base, text: "hi", ...e }) as OutboxEvent;
      mkdirSync(join(root, slug), { recursive: true });
      appendFileSync(rig.outboxPath(slug), JSON.stringify(full) + "\n");
      return full;
    },
    inbox(slug) {
      try {
        const raw = require("node:fs").readFileSync(rig.inboxPath(slug), "utf8") as string;
        return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch { return []; }
    },
  };
  return rig;
}

/** the channel id the fake handed out for a project */
export function channelId(rig: Rig, slug: string): string {
  const p = rig.tx.channels.get(`liaison-${slug}`);
  if (!p) throw new Error(`channel for ${slug} not created`);
  return p.id;
}
