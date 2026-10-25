// ---------------------------------------------------------------------------
// routing-office-default.test.ts — the registry decides where a folder talks.
//
// A folder inside a registered project goes to that project's channel (longest
// path prefix wins). Anything else goes to the OFFICE channel. Resolving never
// writes projects.yml: only `slack-register` and `./setup` do.
// ---------------------------------------------------------------------------
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeNotConfigured, parseRegistry, resolveProject } from "../src/config.ts";
import { readRegistry } from "../src/register.ts";
import { ask, drainInbox, projectSlug, say } from "../src/client.ts";
import { bridgePaths } from "../src/paths.ts";
import { readLines } from "../src/jsonl.ts";

let root: string;
const ymlPath = () => bridgePaths(root).projectsFile;
const hash = () => createHash("sha256").update(readFileSync(ymlPath())).digest("hex");

const WITH_OFFICE = `office:
  path: /tmp/lia/office
  channel: liaison-office
projects:
  - slug: demo
    channel: liaison-demo
    paths:
      - /tmp/lia/demo
`;
const WITHOUT_OFFICE = `projects:
  - slug: demo
    channel: liaison-demo
    paths:
      - /tmp/lia/demo
`;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lia-route-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveProject: registered -> its channel, else the office", () => {
  test("an unregistered folder resolves to the office and projects.yml is untouched", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    const before = hash();
    const r = resolveProject(await readRegistry(ymlPath()), "/tmp/x/unregistered");
    expect(r).toMatchObject({ slug: "office", channel: "liaison-office", registered: false });
    expect(hash()).toBe(before);
  });

  test("a registered folder (or a subfolder of it) resolves to its project", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    const reg = await readRegistry(ymlPath());
    expect(resolveProject(reg, "/tmp/lia/demo")).toMatchObject({ slug: "demo", channel: "liaison-demo", registered: true });
    expect(resolveProject(reg, "/tmp/lia/demo/src/deep")).toMatchObject({ slug: "demo", registered: true });
  });

  test("a sibling that merely shares a string prefix does not match", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    expect(resolveProject(await readRegistry(ymlPath()), "/tmp/lia/demo-lab")).toMatchObject({ slug: "office", registered: false });
  });

  test("the longest registered prefix wins", async () => {
    writeFileSync(ymlPath(), `${WITH_OFFICE}  - slug: inner
    channel: liaison-inner
    paths:
      - /tmp/lia/demo/inner
`);
    const reg = await readRegistry(ymlPath());
    expect(resolveProject(reg, "/tmp/lia/demo/inner/x").slug).toBe("inner");
    expect(resolveProject(reg, "/tmp/lia/demo/other").slug).toBe("demo");
  });

  test("without an office entry an unregistered folder throws OfficeNotConfigured", async () => {
    writeFileSync(ymlPath(), WITHOUT_OFFICE);
    const before = hash();
    expect(() => resolveProject(parseRegistry(WITHOUT_OFFICE), "/tmp/x/unregistered")).toThrow(OfficeNotConfigured);
    expect(hash()).toBe(before);
  });

  test("a missing projects.yml reads as an empty registry, and is not created", async () => {
    const reg = await readRegistry(ymlPath());
    expect(reg).toEqual({ office: null, projects: [] });
    expect(() => resolveProject(reg, "/tmp/x")).toThrow(OfficeNotConfigured);
    expect(existsSync(ymlPath())).toBe(false);
  });

});

describe("say / ask / inbox follow the same rule and never write projects.yml", () => {
  test("say from an unregistered folder lands in the office outbox", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    const before = hash();
    const e = await say({ root, cwd: "/tmp/x/unregistered", text: "hello" });
    expect(e.project).toBe("office");
    expect(e.registered).toBe(false);
    expect(await readLines(join(root, "office", "outbox.jsonl"))).toHaveLength(1);
    expect(hash()).toBe(before);
  });

  test("say from a registered folder lands in that project's outbox", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    const e = await say({ root, cwd: "/tmp/lia/demo/src", text: "hello" });
    expect(e.project).toBe("demo");
    expect(e.registered).toBe(true);
    expect(await readLines(join(root, "demo", "outbox.jsonl"))).toHaveLength(1);
  });

  test("ask from an unregistered folder goes to the office too", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    const e = await ask({ root, cwd: "/tmp/x/unregistered", text: "?", type: "yesno" });
    expect(e.project).toBe("office");
  });

  test("with no office configured, say refuses and writes nothing, not even projects.yml", async () => {
    await expect(say({ root, cwd: "/tmp/x/unregistered", text: "hello" })).rejects.toBeInstanceOf(OfficeNotConfigured);
    expect(existsSync(join(root, "office"))).toBe(false);
    expect(existsSync(ymlPath())).toBe(false);
  });

  test("the office inbox is <root>/office/inbox.jsonl; reading it registers nothing", async () => {
    writeFileSync(ymlPath(), WITH_OFFICE);
    const before = hash();
    expect(await projectSlug(root, "/tmp/x/unregistered")).toBe("office");
    expect(bridgePaths(root).inbox("office")).toBe(join(root, "office", "inbox.jsonl"));
    expect(await drainInbox({ root, cwd: "/tmp/x/unregistered" })).toEqual([]);
    expect(hash()).toBe(before);
  });
});
