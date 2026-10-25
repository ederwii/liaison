// ---------------------------------------------------------------------------
// THE REGISTRY SHAPE. The daemon diffs the parsed projects.yml by JSON
// (reloadProjects), so a parsed project must carry exactly the keys the file
// declared — an unrequested key would look like a change on every reload. And
// slack-register may write only slug, channel and paths: a registered folder
// gets default routing and nothing else.
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { parseProjectsYml, renderProjectEntry } from "../src/config.ts";

describe("registration writes only slug, channel and paths", () => {
  test("the rendered entry has exactly those keys", () => {
    const entry = renderProjectEntry(
      { slug: "brand-new", channel: "liaison-brand-new", paths: ["/home/me/brand-new"] },
      "2000-01-01T00:00:00.000Z",
    );
    const keys = [...entry.matchAll(/^\s*(?:- )?(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(["slug", "channel", "paths"]);
  });

  test("extra fields on a ProjectConfig are never serialised", () => {
    const entry = renderProjectEntry(
      { slug: "sneaky", channel: "liaison-sneaky", paths: ["/x"], admins: ["U_ADMIN"] },
      "stamp",
    );
    expect(entry).not.toContain("admins");
    expect(entry).not.toContain("U_ADMIN");
  });

  test("round trip: register -> parse gives back the same project", () => {
    const yml = `projects:${renderProjectEntry(
      { slug: "hire-ready", channel: "liaison-hire-ready", paths: ["/home/me/hire-ready"] },
      "stamp",
    )}`;
    expect(parseProjectsYml(yml)[0]).toEqual({
      slug: "hire-ready", channel: "liaison-hire-ready", paths: ["/home/me/hire-ready"],
    });
  });
});

describe("parsing is tolerant: unknown keys are ignored", () => {
  test("parsed shape gains no keys", () => {
    const p = parseProjectsYml("projects:\n  - slug: x\n    channel: c\n    paths:\n      - /p\n")[0]!;
    expect(p).toEqual({ slug: "x", channel: "c", paths: ["/p"] });
  });

  test("a key from another version of the file does not leak into the project", () => {
    const p = parseProjectsYml("projects:\n  - slug: x\n    provider: other\n    other_channel_id: abc\n")[0]!;
    expect(p).toEqual({ slug: "x", channel: "liaison-x", paths: [] });
  });
});
