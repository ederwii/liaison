import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";
import { sanitizeFileName } from "../src/paths.ts";
import { MAX_ATTACHMENT_BYTES, validateAttachment } from "../src/args.ts";

let rig: Rig;
beforeEach(async () => { rig = makeRig(); await rig.daemon.start(); });
afterEach(async () => { await rig.daemon.stop(); rig.cleanup(); });

async function openChannels() {
  rig.push("alpha", { kind: "say", text: "boot" });
  await rig.daemon.pump();
}

describe("inbound files", () => {
  test("a message with an attachment downloads it and records an absolute path", async () => {
    await openChannels();
    const url = "https://files.slack.com/files-pri/T0/F0-screenshot.png/download/screenshot.png";
    rig.tx.downloads.set(url, Buffer.from("fake-png-bytes"));
    await rig.tx.say({
      channel: channelId(rig, "alpha"), user: OWNER, text: "look at this",
      files: [{ id: "F0", name: "screenshot.png", mimetype: "image/png", size: 14, urlPrivateDownload: url }],
    });
    const [line] = rig.inbox("alpha");
    expect(line.kind).toBe("message");
    expect(line.text).toBe("look at this");
    expect(line.files).toHaveLength(1);
    expect(line.files[0].error).toBeUndefined();
    expect(line.files[0].path.startsWith("/")).toBe(true);
    expect(existsSync(line.files[0].path)).toBe(true);
    expect(readFileSync(line.files[0].path, "utf8")).toBe("fake-png-bytes");
    // the slack_ts of the message prefixes the stored filename
    expect(line.files[0].path.includes(line.slack_ts)).toBe(true);
  });

  test("an attachment with no caption still produces an inbox line (text: '')", async () => {
    await openChannels();
    const url = "https://files.slack.com/f1/download/photo.jpg";
    rig.tx.downloads.set(url, Buffer.from("x"));
    await rig.tx.say({
      channel: channelId(rig, "alpha"), user: OWNER, text: "",
      files: [{ id: "F1", name: "photo.jpg", mimetype: "image/jpeg", size: 1, urlPrivateDownload: url }],
    });
    const [line] = rig.inbox("alpha");
    expect(line.text).toBe("");
    expect(line.files[0].path).toBeTruthy();
  });

  test("a download failure records {error} and does not throw / does not drop the message", async () => {
    await openChannels();
    await rig.tx.say({
      channel: channelId(rig, "alpha"), user: OWNER, text: "broken",
      files: [{
        id: "F2", name: "dead.png", mimetype: "image/png", size: 1,
        urlPrivateDownload: "https://files.slack.com/no-fixture-for-this",
      }],
    });
    const [line] = rig.inbox("alpha");
    expect(line.text).toBe("broken");
    expect(line.files[0].path).toBeUndefined();
    expect(typeof line.files[0].error).toBe("string");
  });

  test("the filename is sanitized: path traversal in the Slack-supplied name cannot escape files/", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\windows\\win.ini")).toBe("win.ini");
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("")).toBe("file");
  });

  test("plain-text messages (no files key) are unaffected — schema stays backward compatible", async () => {
    await openChannels();
    await rig.tx.say({ channel: channelId(rig, "alpha"), user: OWNER, text: "text only" });
    const [line] = rig.inbox("alpha");
    expect(line.files).toBeUndefined();
    expect(line.text).toBe("text only");
  });
});

describe("outbound files", () => {
  let tmpFile: string;
  beforeEach(() => { tmpFile = join(mkdtempSync(join(tmpdir(), "sb-out-")), "report.png"); writeFileSync(tmpFile, "bytes"); });

  test("a say with `file` uploads instead of posting plain text", async () => {
    await openChannels();
    rig.push("alpha", { kind: "say", text: "look at the screenshot", file: { path: tmpFile } } as never);
    await rig.daemon.pump();
    expect(rig.tx.uploads).toHaveLength(1);
    expect(rig.tx.uploads[0]!.path).toBe(tmpFile);
    expect(rig.tx.uploads[0]!.text).toBe("look at the screenshot");
  });

  test("a provider without uploadFile support fails into the inbox, never throws", async () => {
    await openChannels();
    // simulate an unsupported transport by deleting the method
    (rig.tx as { uploadFile?: unknown }).uploadFile = undefined;
    rig.push("alpha", { kind: "say", text: "x", file: { path: tmpFile } } as never);
    await rig.daemon.pump();
    const lines = rig.inbox("alpha");
    expect(lines.at(-1)!.kind).toBe("error");
  });
});

describe("validateAttachment (bin/slack-say --file validation)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sb-attach-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("a missing file is rejected", () => {
    expect(validateAttachment(join(dir, "nope.png"))).toMatch(/not found/);
  });

  test("a directory is rejected", () => {
    expect(validateAttachment(dir)).toMatch(/not a regular file/);
  });

  test("an existing small file passes", () => {
    const f = join(dir, "ok.png");
    writeFileSync(f, "small");
    expect(validateAttachment(f)).toBeUndefined();
  });

  test("a file over 20 MB is rejected", () => {
    const f = join(dir, "big.bin");
    writeFileSync(f, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    expect(validateAttachment(f)).toMatch(/too large/);
  });
});
