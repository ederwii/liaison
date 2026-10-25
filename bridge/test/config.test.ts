import { describe, expect, test } from "bun:test";
import { daemonProjects, parseEnvFile, parseProjectsYml, parseRegistry, resolveProject } from "../src/config.ts";

const YML = `
projects:
  - slug: alpha
    channel: liaison-alpha
    paths:
      - /home/me/alpha-v2
  - slug: beta
    channel: liaison-beta
    paths:
      - /home/me/beta
      - /home/me/beta/mobile
`;

describe("projects.yml", () => {
  test("parses slug/channel/paths", () => {
    const p = parseProjectsYml(YML);
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ slug: "alpha", channel: "liaison-alpha", paths: ["/home/me/alpha-v2"] });
    expect(p[1]!.paths).toHaveLength(2);
  });
  test("ignores comments and blank lines", () => {
    expect(parseProjectsYml("# nothing here\n\nprojects:\n")).toEqual([]);
  });
});

describe("resolveProject (cwd -> project)", () => {
  const reg = parseRegistry(`office:\n  path: /home/me/office\n${YML}`);
  test("matches the LONGEST path prefix, so a sub-repo wins", () => {
    expect(resolveProject(reg, "/home/me/beta/mobile/src").slug).toBe("beta");
    expect(resolveProject(reg, "/home/me/alpha-v2/src/x").slug).toBe("alpha");
  });
  test("never prefix-matches a sibling directory by string alone", () => {
    // /home/me/beta-lab must NOT match /home/me/beta: it falls to the office
    const r = resolveProject(reg, "/home/me/beta-lab");
    expect(r).toMatchObject({ slug: "office", channel: "liaison-office", registered: false });
  });
  test("an unknown path resolves to the office; it is never derived from the directory name", () => {
    const r = resolveProject(reg, "/home/me/brand-new");
    expect(r.slug).toBe("office");
    expect(r.registered).toBe(false);
  });
});

describe("office: block", () => {
  test("parses path and channel; the channel defaults to liaison-office", () => {
    expect(parseRegistry("office:\n  path: /o\n  channel: hq\nprojects:\n").office).toEqual({ path: "/o", channel: "hq" });
    expect(parseRegistry("office:\n  path: /o\n").office).toEqual({ path: "/o", channel: "liaison-office" });
  });
  test("an office block without a path is ignored", () => {
    expect(parseRegistry("office:\n  channel: hq\n").office).toBeNull();
  });
  test("an office block does not leak keys into the project list, in either order", () => {
    const a = parseRegistry(`office:\n  path: /o\n${YML}`);
    const b = parseRegistry(`${YML}office:\n  path: /o\n  channel: hq\n`);
    expect(a.projects).toHaveLength(2);
    expect(b.projects).toHaveLength(2);
    expect(b.projects[1]!.paths).toEqual(["/home/me/beta", "/home/me/beta/mobile"]);
    expect(b.office).toEqual({ path: "/o", channel: "hq" });
  });
  test("the daemon routes the office as one more project", () => {
    const d = daemonProjects(parseRegistry(`office:\n  path: /o\n${YML}`));
    expect(d.map((p) => p.slug)).toEqual(["alpha", "beta", "office"]);
    expect(d[2]).toEqual({ slug: "office", channel: "liaison-office", paths: ["/o"] });
  });
});

describe("parseEnvFile", () => {
  test("reads KEY=VALUE, ignores comments, strips quotes", () => {
    const e = parseEnvFile('# c\nA=1\nB="two"\nC=\'three\'\n\nD=has=equals\n');
    expect(e).toEqual({ A: "1", B: "two", C: "three", D: "has=equals" });
  });
  test("tolerates `export ` prefixes", () => {
    expect(parseEnvFile("export TOKEN=abc\n")).toEqual({ TOKEN: "abc" });
  });
});
