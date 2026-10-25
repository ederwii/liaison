// ---------------------------------------------------------------------------
// register.test.ts — registerProject / registerOffice, the only writers of
// projects.yml. Collisions are refused (never merged), re-registering is a
// no-op, and the owner's hand edits survive every write.
// ---------------------------------------------------------------------------
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegisterCollision, RegisterUsageError, readRegistry, registerOffice, registerProject } from "../src/register.ts";
import { parseRegistry } from "../src/config.ts";

let root: string;
let home: string;
let realHome: string | undefined;
const file = () => join(root, "projects.yml");
const yml = () => readFileSync(file(), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lia-register-"));
  home = mkdtempSync(join(tmpdir(), "lia-home-"));
  realHome = process.env["HOME"];
  process.env["HOME"] = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = realHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("registerProject writes the project into projects.yml", () => {
  test("creates the file with a header and one entry on the default channel", async () => {
    const r = await registerProject(root, "/w/hire-ready", "hire-ready");
    expect(r).toEqual({ slug: "hire-ready", channel: "liaison-hire-ready", base: "/w/hire-ready", registered: true });
    expect(yml()).toContain("# ~/.liaison/projects.yml");
    expect(parseRegistry(yml()).projects).toEqual([{ slug: "hire-ready", channel: "liaison-hire-ready", paths: ["/w/hire-ready"] }]);
  });

  test("the second identical call returns registered:false and leaves the file byte-identical", async () => {
    await registerProject(root, "/w/hire-ready", "hire-ready");
    const before = yml();
    const again = await registerProject(root, "/w/hire-ready/", "hire-ready");
    expect(again.registered).toBe(false);
    expect(yml()).toBe(before);
  });

  test("a trailing slash and ~ are normalised", async () => {
    const r = await registerProject(root, "~/fresh-repo/", "fresh");
    expect(r.base).toBe(join(home, "fresh-repo"));
  });

  test("a nested path under another project is allowed: the longest prefix routes", async () => {
    await registerProject(root, "/w/beta", "beta");
    await registerProject(root, "/w/beta/mobile", "beta-mobile");
    expect(parseRegistry(yml()).projects.map((p) => p.slug)).toEqual(["beta", "beta-mobile"]);
  });

  test("the owner's hand edits and comments survive a registration", async () => {
    writeFileSync(file(), "# mine\nprojects:\n  - slug: alpha   # keep me\n    channel: team-alpha\n    paths:\n      - /w/alpha\n");
    await registerProject(root, "/w/beta", "beta");
    expect(yml()).toContain("# mine");
    expect(yml()).toContain("# keep me");
    expect(parseRegistry(yml()).projects.map((p) => p.channel)).toEqual(["team-alpha", "liaison-beta"]);
  });

  test("a file with no projects: key gets one instead of swallowing the entry", async () => {
    writeFileSync(file(), "# empty\n");
    await registerProject(root, "/w/beta", "beta");
    expect(parseRegistry(yml()).projects).toHaveLength(1);
  });

  test("a hand-written office: block AFTER projects: does not swallow the new entry", async () => {
    writeFileSync(file(), "projects:\n  - slug: alpha\n    channel: liaison-alpha\n    paths:\n      - /w/alpha\noffice:\n  path: /w/office\n  channel: hq\n");
    await registerProject(root, "/w/beta", "beta");
    const reg = parseRegistry(yml());
    expect(reg.projects.map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(reg.office).toEqual({ path: "/w/office", channel: "hq" });
  });

  test("leaves no temp or lock files behind", async () => {
    await registerProject(root, "/w/beta", "beta");
    expect(readdirSync(root)).toEqual(["projects.yml"]);
  });
});

describe("collisions are refused, by name and path, and write nothing", () => {
  test("the same name for another path", async () => {
    await registerProject(root, "/w/one/beta", "beta");
    const before = yml();
    const boom = registerProject(root, "/w/two/beta", "beta");
    await expect(boom).rejects.toBeInstanceOf(RegisterCollision);
    await expect(boom).rejects.toThrow(/\/w\/one\/beta/);
    expect(yml()).toBe(before);
  });

  test("the same path under another name", async () => {
    await registerProject(root, "/w/beta", "beta");
    await expect(registerProject(root, "/w/beta", "gamma")).rejects.toThrow(/already registered as "beta"/);
  });

  test("the same name and path on a different explicit channel", async () => {
    await registerProject(root, "/w/beta", "beta");
    await expect(registerProject(root, "/w/beta", "beta", "elsewhere")).rejects.toBeInstanceOf(RegisterCollision);
  });

  test("a channel another project already uses", async () => {
    await registerProject(root, "/w/beta", "beta");
    await expect(registerProject(root, "/w/gamma", "gamma", "liaison-beta")).rejects.toThrow(/liaison-beta/);
  });

  test("the office channel", async () => {
    await registerOffice(root, "/w/office");
    await expect(registerProject(root, "/w/gamma", "gamma", "liaison-office")).rejects.toBeInstanceOf(RegisterCollision);
  });

  test('the reserved name "office"', async () => {
    await expect(registerProject(root, "/w/gamma", "office")).rejects.toBeInstanceOf(RegisterCollision);
    expect(existsSync(file())).toBe(false);
  });
});

describe("bad input is a usage error, not a collision", () => {
  test("relative path", async () => {
    await expect(registerProject(root, "relative/dir", "x")).rejects.toBeInstanceOf(RegisterUsageError);
  });
  test("invalid project and channel names", async () => {
    await expect(registerProject(root, "/w/x", "Has Space")).rejects.toBeInstanceOf(RegisterUsageError);
    await expect(registerProject(root, "/w/x", "x", "#Bad")).rejects.toBeInstanceOf(RegisterUsageError);
  });
  test("the filesystem root and the home directory", async () => {
    await expect(registerProject(root, "/", "x")).rejects.toBeInstanceOf(RegisterUsageError);
    await expect(registerProject(root, home, "x")).rejects.toThrow(/home directory/i);
    expect(existsSync(file())).toBe(false);
  });
});

describe("concurrency and aliases", () => {
  test("two processes registering the same project at once write one entry", async () => {
    await Promise.all([registerProject(root, "/w/racy", "racy"), registerProject(root, "/w/racy", "racy")]);
    expect(parseRegistry(yml()).projects).toHaveLength(1);
  });

  test("two different projects at once both land", async () => {
    await Promise.all([registerProject(root, "/w/one", "one"), registerProject(root, "/w/two", "two")]);
    expect(parseRegistry(yml()).projects.map((p) => p.slug).sort()).toEqual(["one", "two"]);
  });

  test("a symlinked spelling of the same directory is the same registration", async () => {
    const real = join(root, "real", "gadget");
    mkdirSync(real, { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    expect((await registerProject(root, join(root, "link", "gadget"), "gadget")).registered).toBe(true);
    expect((await registerProject(root, real, "gadget")).registered).toBe(false);
    expect(parseRegistry(yml()).projects).toHaveLength(1);
  });
});

describe("registerOffice", () => {
  test("writes the office above projects: and is idempotent", async () => {
    await registerProject(root, "/w/beta", "beta");
    const first = await registerOffice(root, "/w/office");
    expect(first).toEqual({ slug: "office", channel: "liaison-office", base: "/w/office", registered: true });
    expect(yml().indexOf("office:")).toBeLessThan(yml().indexOf("projects:"));
    const before = yml();
    expect((await registerOffice(root, "/w/office")).registered).toBe(false);
    expect(yml()).toBe(before);
    expect((await readRegistry(file())).projects).toHaveLength(1);
  });

  test("registering a different office path replaces the entry in place", async () => {
    await registerOffice(root, "/w/office");
    await registerProject(root, "/w/beta", "beta");
    await registerOffice(root, "/w/new-office", "hq");
    const reg = parseRegistry(yml());
    expect(reg.office).toEqual({ path: "/w/new-office", channel: "hq" });
    expect(reg.projects.map((p) => p.slug)).toEqual(["beta"]);
    expect(yml().match(/^office:/gm)).toHaveLength(1);
  });

  test("on an empty file it also writes the projects: key", async () => {
    await registerOffice(root, "/w/office");
    expect(yml()).toMatch(/^projects:\s*$/m);
  });

  test("an office channel a project already uses is a collision", async () => {
    await registerProject(root, "/w/beta", "beta", "liaison-office");
    await expect(registerOffice(root, "/w/office")).rejects.toBeInstanceOf(RegisterCollision);
  });

  test("a relative office path is a usage error", async () => {
    await expect(registerOffice(root, "office")).rejects.toBeInstanceOf(RegisterUsageError);
  });
});
