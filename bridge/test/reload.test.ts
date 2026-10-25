// ---------------------------------------------------------------------------
// reload.test.ts — the daemon must notice a project registered AFTER it booted.
//
// projects.yml is read once at boot and again whenever it changes. That is
// correct for the ALLOWLIST — a bridge whose allowlist can be changed by
// whatever can write a file is not a boundary — but it is wrong for the project
// registry: slack-register writes that file, and the owner should not have to `launchctl kickstart` to make their own repo work.
//
// The reload is driven from pump(), which is already woken by BOTH the fs.watch
// in index.ts and the 500ms poll. No second watcher, no new failure mode.
// ---------------------------------------------------------------------------
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";

let rig: Rig;
const ymlFile = (): string => join(rig.root, "projects.yml");

function writeYml(body: string): void { writeFileSync(ymlFile(), body); }

const BOOT_YML = `projects:
  - slug: alpha
    channel: liaison-alpha
    paths:
      - /home/me/alpha-v2
  - slug: beta
    channel: liaison-beta
    paths:
      - /home/me/beta
`;

const WITH_NEWCOMER = `${BOOT_YML}  - slug: hire-ready
    channel: liaison-hire-ready
    paths:
      - /home/me/hire-ready
`;

beforeEach(async () => { rig = makeRig(); writeYml(BOOT_YML); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

describe("projects.yml is re-read without a daemon restart", () => {
  test("a project appended after boot is known to the daemon on the next pump", async () => {
    expect(rig.daemon.projectSlugs()).toEqual(["alpha", "beta"]);
    writeYml(WITH_NEWCOMER);
    await rig.daemon.pump();
    expect(rig.daemon.projectSlugs()).toContain("hire-ready");
  });

  test("its channel is created and the allowlist invited, before it has said anything", async () => {
    writeYml(WITH_NEWCOMER);
    await rig.daemon.pump();
    expect(rig.tx.channels.has("liaison-hire-ready")).toBe(true);
    expect(rig.tx.invites.get(channelId(rig, "hire-ready"))).toEqual([OWNER]);
  });

  test("so inbound chat routes to the new project before its first say", async () => {
    writeYml(WITH_NEWCOMER);
    await rig.daemon.pump();
    await rig.tx.say({ channel: channelId(rig, "hire-ready"), user: OWNER, text: "hello" });
    expect(rig.inbox("hire-ready").map((l) => l.text)).toEqual(["hello"]);
  });

  test("an office: block added after boot gets its channel, and chat there routes to the office inbox", async () => {
    writeYml(`office:\n  path: /home/me/office\n${BOOT_YML}`);
    await rig.daemon.pump();
    expect(rig.daemon.projectSlugs()).toContain("office");
    expect(rig.tx.channels.has("liaison-office")).toBe(true);
    expect(rig.tx.invites.get(channelId(rig, "office"))).toEqual([OWNER]);
    await rig.tx.say({ channel: channelId(rig, "office"), user: OWNER, text: "hi office" });
    expect(rig.inbox("office").map((l) => l.text)).toEqual(["hi office"]);
  });

  test("a CUSTOM channel name added after boot is honoured, not the derived one", async () => {
    writeYml(`${BOOT_YML}  - slug: newcomer
    channel: team-newcomer
    paths:
      - /home/me/newcomer
`);
    await rig.daemon.pump();
    rig.push("newcomer", { kind: "say", text: "custom" });
    await rig.daemon.pump();
    expect(rig.tx.channels.has("team-newcomer")).toBe(true);
    expect(rig.tx.channels.has("liaison-newcomer")).toBe(false);
    expect(rig.tx.posts.at(-1)!.channel).toBe(rig.tx.channels.get("team-newcomer")!.id);
  });

  test("an unchanged file is not re-applied — no repeat channel creation or re-invite", async () => {
    writeYml(WITH_NEWCOMER);
    await rig.daemon.pump();
    await rig.daemon.pump();
    await rig.daemon.pump();
    expect(rig.tx.invites.get(channelId(rig, "hire-ready"))).toEqual([OWNER]);
    expect(rig.tx.channels.size).toBe(1);
  });

  test("the reload logs what it picked up", async () => {
    writeYml(WITH_NEWCOMER);
    await rig.daemon.pump();
    const rec = rig.daemon.logs.find((l) => l.msg === "projects_reloaded");
    expect(rec).toBeDefined();
    expect(rec!.fields).toMatchObject({ added: ["hire-ready"] });
  });
});

describe("a bad read never costs the daemon its project registry", () => {
  test("an empty projects.yml (a writer caught mid-truncate) is ignored", async () => {
    writeYml("");
    await rig.daemon.pump();
    expect(rig.daemon.projectSlugs()).toEqual(["alpha", "beta"]);
    expect(rig.daemon.logs.some((l) => l.msg === "projects_reload_ignored")).toBe(true);
  });

  test("a DELETED projects.yml is ignored — the boot registry stands", async () => {
    rmSync(ymlFile());
    await rig.daemon.pump();
    expect(rig.daemon.projectSlugs()).toEqual(["alpha", "beta"]);
  });

  test("a daemon that never had a projects.yml keeps its injected config (the whole test suite)", async () => {
    const r = makeRig();
    await r.daemon.start();
    r.push("alpha", { kind: "say", text: "hello" });
    await r.daemon.pump();
    expect(r.tx.posts).toHaveLength(1);
    expect(r.daemon.projectSlugs()).toEqual(["alpha", "beta"]);
    await r.daemon.stop(); r.cleanup();
  });

  test("a channel that cannot be created on reload does not break the pump", async () => {
    writeYml(WITH_NEWCOMER);
    rig.tx.failEnsureChannel = 1;
    rig.push("alpha", { kind: "say", text: "still delivered" });
    await rig.daemon.pump();
    expect(rig.tx.posts.some((p) => p.text.includes("still delivered"))).toBe(true);
  });

  test("a project REMOVED from the file stops being pre-ensured but never crashes", async () => {
    writeYml(WITH_NEWCOMER);
    await rig.daemon.pump();
    writeYml(BOOT_YML);
    await rig.daemon.pump();
    expect(rig.daemon.projectSlugs()).toEqual(["alpha", "beta"]);
  });
});

describe("a registered project reaches Slack end to end", () => {
  test("register (file) then say (outbox) lands in the derived channel in one pump", async () => {
    mkdirSync(join(rig.root, "demo-project"), { recursive: true });
    writeYml(`${BOOT_YML}  - slug: demo-project
    channel: liaison-demo-project
    paths:
      - /home/me/demo-project
`);
    rig.push("demo-project", { kind: "say", text: "registration works" });
    await rig.daemon.pump();
    const post = rig.tx.posts.find((p) => p.text.includes("registration works"));
    expect(post).toBeDefined();
    expect(post!.channel).toBe(channelId(rig, "demo-project"));
    expect(rig.tx.invites.get(channelId(rig, "demo-project"))).toEqual([OWNER]);
  });
});

// ---------------------------------------------------------------------------
// The owner swaps the Slack app for a different one (say, a shared dev app for
// a dedicated `liaison` app). The channel IDS in state.json are still correct
// — a channel id does not change — but MEMBERSHIP does not transfer: the new
// bot is not in any #liaison-* the old one created, and chat.postMessage into a
// public channel you are not in fails `not_in_channel`.
//
// channelIdFor() short-circuits on the cached id, so conversations.join (which
// lives inside SocketModeTransport.ensureChannel) was never reached for a
// channel we already knew. ensureAllChannels() now refreshes past that cache.
// ---------------------------------------------------------------------------
describe("boot re-resolves known channels, so a NEW bot identity joins them", () => {
  test("ensureAllChannels calls ensureChannel even for channels already in state.json", async () => {
    const r = makeRig();
    writeFileSync(join(r.root, "state.json"), JSON.stringify({
      version: 1, cursors: {}, questions: {}, paused: {},
      channels: { "liaison-alpha": "C_OLD_APP", "liaison-beta": "C_OLD_APP_2" },
    }));
    await r.daemon.start();
    expect(r.tx.ensureChannelCalls).toEqual([]);          // start() alone must not
    await r.daemon.ensureAllChannels();
    expect(r.tx.ensureChannelCalls).toEqual(["liaison-alpha", "liaison-beta"]);
    await r.daemon.stop(); r.cleanup();
  });

  test("one unreachable channel does not stop the daemon booting the rest", async () => {
    const r = makeRig();
    await r.daemon.start();
    r.tx.failEnsureChannel = 1;
    await r.daemon.ensureAllChannels();                    // must not throw
    expect(r.tx.ensureChannelCalls).toEqual(["liaison-alpha", "liaison-beta"]);
    expect(r.daemon.logs.some((l) => l.msg === "ensure_channel_failed")).toBe(true);
    await r.daemon.stop(); r.cleanup();
  });
});
