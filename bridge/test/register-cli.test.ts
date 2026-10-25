// ---------------------------------------------------------------------------
// register-cli.test.ts — bin/slack-register and the exit codes of the verbs
// that route by the registry. Real processes against a throwaway LIAISON_ROOT.
// ---------------------------------------------------------------------------
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegistry } from "../src/config.ts";

const BIN = join(import.meta.dir, "..", "bin");
let root: string;
let work: string;
const ymlPath = () => join(root, "projects.yml");
const read = () => readFileSync(ymlPath(), "utf8");
const hash = () => createHash("sha256").update(readFileSync(ymlPath())).digest("hex");

function run(verb: string, args: string[], cwd = work) {
  const r = Bun.spawnSync(["bun", join(BIN, verb), ...args], {
    cwd, env: { ...process.env, LIAISON_ROOT: root }, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lia-regcli-root-"));
  work = mkdtempSync(join(tmpdir(), "lia-regcli-work-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("slack-register <abs-path> <name>", () => {
  test("registers one entry and prints `registered <name> -> #<channel>`", () => {
    const r = run("slack-register", ["/tmp/p", "demo"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("registered demo -> #liaison-demo");
    const reg = parseRegistry(read());
    expect(reg.projects).toEqual([{ slug: "demo", channel: "liaison-demo", paths: ["/tmp/p"] }]);
  });

  test("an identical second call exits 0 and writes nothing", () => {
    run("slack-register", ["/tmp/p", "demo"]);
    const before = read();
    const r = run("slack-register", ["/tmp/p", "demo"]);
    expect(r.code).toBe(0);
    expect(read()).toBe(before);
  });

  test("the same name for a different path exits 3 and writes nothing", () => {
    run("slack-register", ["/tmp/p", "demo"]);
    const before = hash();
    const r = run("slack-register", ["/tmp/q", "demo"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("demo");
    expect(hash()).toBe(before);
  });

  test("--channel overrides the default channel; clashing with another project's channel exits 3", () => {
    expect(run("slack-register", ["/tmp/p", "demo", "--channel", "team-demo"]).code).toBe(0);
    expect(parseRegistry(read()).projects[0]!.channel).toBe("team-demo");
    expect(run("slack-register", ["/tmp/q", "other", "--channel", "team-demo"]).code).toBe(3);
  });

  test("bad usage exits 2 (relative path, missing name, invalid name); the reserved name 'office' exits 3", () => {
    expect(run("slack-register", ["relative/dir", "demo"]).code).toBe(2);
    expect(run("slack-register", ["/tmp/p"]).code).toBe(2);
    expect(run("slack-register", ["/tmp/p", "Bad Name!"]).code).toBe(2);
    expect(existsSync(ymlPath())).toBe(false);
    expect(run("slack-register", ["/tmp/p", "office"]).code).toBe(3);
  });
});

describe("slack-register --office <abs-path>", () => {
  test("writes the office key with the default channel; a second identical call is a no-op", () => {
    const r = run("slack-register", ["--office", "/tmp/lia-office"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("registered office -> #liaison-office");
    expect(parseRegistry(read()).office).toEqual({ path: "/tmp/lia-office", channel: "liaison-office" });
    const before = read();
    expect(run("slack-register", ["--office", "/tmp/lia-office"]).code).toBe(0);
    expect(read()).toBe(before);
  });

  test("--channel names the office channel; registering projects keeps the office entry", () => {
    run("slack-register", ["--office", "/tmp/lia-office", "--channel", "hq"]);
    run("slack-register", ["/tmp/p", "demo"]);
    const reg = parseRegistry(read());
    expect(reg.office).toEqual({ path: "/tmp/lia-office", channel: "hq" });
    expect(reg.projects.map((p) => p.slug)).toEqual(["demo"]);
  });

  test("a project registered first, then the office: both survive", () => {
    run("slack-register", ["/tmp/p", "demo"]);
    run("slack-register", ["--office", "/tmp/lia-office"]);
    const reg = parseRegistry(read());
    expect(reg.office?.channel).toBe("liaison-office");
    expect(reg.projects.map((p) => p.slug)).toEqual(["demo"]);
  });

  test("an office channel that a project already uses exits 3", () => {
    run("slack-register", ["/tmp/p", "demo", "--channel", "liaison-office"]);
    expect(run("slack-register", ["--office", "/tmp/lia-office"]).code).toBe(3);
  });
});

describe("the verbs route by the registry", () => {
  test("slack-say in an unregistered folder with no office exits 4 and points at ./setup", () => {
    const r = run("slack-say", ["hello"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("./setup");
    expect(existsSync(ymlPath())).toBe(false);
  });

  test("slack-ask in an unregistered folder with no office exits 4", () => {
    expect(run("slack-ask", ["ship it?"]).code).toBe(4);
  });

  test("slack-say in an unregistered folder posts to the office and does not touch projects.yml", () => {
    run("slack-register", ["--office", "/tmp/lia-office"]);
    const before = hash();
    const r = run("slack-say", ["hello"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("office");
    expect(hash()).toBe(before);
    expect(existsSync(join(root, "office", "outbox.jsonl"))).toBe(true);
  });

  test("slack-say and slack-ask from the office folder (or under it) do not warn that the folder is unregistered", () => {
    mkdirSync(join(work, "sub"));
    run("slack-register", ["--office", work]);
    for (const cwd of [work, join(work, "sub")]) {
      const say = run("slack-say", ["hello"], cwd);
      expect(say.code).toBe(0);
      expect(say.err).toContain("queued -> office");
      expect(say.err).not.toContain("not registered");
      const ask = run("slack-ask", ["ok?"], cwd);
      expect(ask.code).toBe(0);
      expect(ask.err).toContain("asked in office");
      expect(ask.err).not.toContain("not registered");
    }
  });

  test("slack-say from a folder outside the office still warns", () => {
    run("slack-register", ["--office", "/tmp/lia-office"]);
    expect(run("slack-say", ["hello"]).err).toContain("not registered");
    expect(run("slack-ask", ["ok?"]).err).toContain("folder not registered");
  });

  test("slack-inbox --path from an unregistered folder prints the office inbox", () => {
    run("slack-register", ["--office", "/tmp/lia-office"]);
    const r = run("slack-inbox", ["--path"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(join(root, "office", "inbox.jsonl"));
  });

  test("slack-inbox --path from a registered folder prints that project's inbox", () => {
    run("slack-register", [work, "demo"]);
    const r = run("slack-inbox", ["--path"]);
    expect(r.out.trim()).toBe(join(root, "demo", "inbox.jsonl"));
  });
});
