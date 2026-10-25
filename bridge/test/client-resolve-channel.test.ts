// ---------------------------------------------------------------------------
// client-resolve-channel.test.ts — resolveChannelId(), the read-only lookup
// bin/slack-ack uses to default --channel from cwd, "like slack-say". Three
// fallbacks, in order: projects.yml channel name -> state.json's channel
// cache; then the most recent channel seen in this project's own inbox; then
// undefined (the CLI must then require --channel explicitly).
// ---------------------------------------------------------------------------
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChannelId } from "../src/client.ts";
import { bridgePaths } from "../src/paths.ts";
import { registerOffice, registerProject } from "../src/register.ts";

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "liaison-ack-test-"));
  cwd = mkdtempSync(join(tmpdir(), "liaison-ack-cwd-alpha-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** projects.yml routes this cwd to project `slugFor(cwd)` on the default channel. */
async function registerCwd(): Promise<void> {
  await registerProject(root, cwd, slugFor(cwd));
}

function slugFor(cwdPath: string): string {
  // mirrors slugForPath(basename) — deterministic enough for these tests
  return cwdPath.split("/").at(-1)!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

describe("resolveChannelId", () => {
  test("resolves via state.json's channel cache, keyed by the derived channel name", async () => {
    const slug = slugFor(cwd);
    const channelName = `liaison-${slug}`;
    await registerCwd();
    writeFileSync(bridgePaths(root).stateFile, JSON.stringify({ channels: { [channelName]: "C0DAEMON1" } }));

    expect(await resolveChannelId(root, cwd)).toBe("C0DAEMON1");
  });

  test("honours an explicit projects.yml channel name over the derived default", async () => {
    const slug = slugFor(cwd);
    mkdirSync(bridgePaths(root).root, { recursive: true });
    writeFileSync(bridgePaths(root).projectsFile, [
      "projects:",
      `  - slug: ${slug}`,
      "    channel: custom-channel-name",
      "    paths:",
      `      - ${cwd}`,
      "",
    ].join("\n"));
    writeFileSync(bridgePaths(root).stateFile, JSON.stringify({
      channels: { "custom-channel-name": "C0CUSTOM1", [`liaison-${slug}`]: "C0WRONG1" },
    }));

    expect(await resolveChannelId(root, cwd)).toBe("C0CUSTOM1");
  });

  test("falls back to the most recent channel seen in this project's inbox when state.json has nothing for it", async () => {
    const slug = slugFor(cwd);
    await registerCwd();
    const dir = bridgePaths(root).projectDir(slug);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { ts: "t1", kind: "message", from: "U_OWNER", text: "hello", channel: "C0OLD", slack_ts: "ts1" },
      { ts: "t2", kind: "message", from: "U_OWNER", text: "again", channel: "C0NEW", slack_ts: "ts2" },
    ];
    writeFileSync(bridgePaths(root).inbox(slug), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    expect(await resolveChannelId(root, cwd)).toBe("C0NEW");
  });

  test("an unregistered cwd resolves through the OFFICE channel", async () => {
    await registerOffice(root, join(root, "office-dir"));
    writeFileSync(bridgePaths(root).stateFile, JSON.stringify({ channels: { "liaison-office": "C0OFFICE1" } }));
    expect(await resolveChannelId(root, cwd)).toBe("C0OFFICE1");
  });

  test("returns undefined when nothing can resolve it — the CLI must then require --channel", async () => {
    await registerCwd();
    expect(await resolveChannelId(root, cwd)).toBeUndefined();
  });
});
