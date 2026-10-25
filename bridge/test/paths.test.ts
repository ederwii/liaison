import { describe, expect, test } from "bun:test";
import { bridgePaths, channelForSlug, slugForPath } from "../src/paths.ts";

describe("project + channel naming", () => {
  test("slug is the repo directory name, lowercased and safe", () => {
    expect(slugForPath("/home/me/alpha-v2")).toBe("alpha-v2");
    expect(slugForPath("/home/me/alpha-v2/")).toBe("alpha-v2");
    expect(slugForPath("/home/me/Beta.Workflows")).toBe("beta-workflows");
    expect(slugForPath("/home/me/My Repo")).toBe("my-repo");
  });
  test("channel is #liaison-<project>", () => {
    expect(channelForSlug("alpha-v2")).toBe("liaison-alpha-v2");
  });
  test("slack channel names cap at 80 chars", () => {
    expect(channelForSlug("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("bridgePaths", () => {
  test("lays out the protocol files under the root", () => {
    const p = bridgePaths("/tmp/sb");
    expect(p.root).toBe("/tmp/sb");
    expect(p.envFile).toBe("/tmp/sb/.env");
    expect(p.projectsFile).toBe("/tmp/sb/projects.yml");
    expect(p.inbox("alpha")).toBe("/tmp/sb/alpha/inbox.jsonl");
    expect(p.outbox("alpha")).toBe("/tmp/sb/alpha/outbox.jsonl");
  });
  test("defaults to ~/.liaison", () => {
    delete process.env.LIAISON_ROOT;
    expect(bridgePaths().root).toBe(`${process.env.HOME}/.liaison`);
  });
  test("LIAISON_ROOT relocates the whole protocol — bin scripts must honour it", () => {
    process.env.LIAISON_ROOT = "/tmp/elsewhere";
    try {
      expect(bridgePaths().root).toBe("/tmp/elsewhere");
      expect(bridgePaths().inbox("p")).toBe("/tmp/elsewhere/p/inbox.jsonl");
      expect(bridgePaths("/explicit").root).toBe("/explicit"); // an explicit arg still wins
    } finally { delete process.env.LIAISON_ROOT; }
  });
});
