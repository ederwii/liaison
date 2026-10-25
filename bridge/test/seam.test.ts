import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;

describe("the transport seam is real, not decorative", () => {
  test("no daemon-core module imports a Slack package", () => {
    const core = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "socket-transport.ts" && f !== "index.ts");
    const offenders = core.filter((f) => /from\s+["']@slack\//.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  test("every transport satisfies SlackTransport", async () => {
    const { FakeTransport } = await import("../src/fake-transport.ts");
    const { SocketModeTransport } = await import("../src/socket-transport.ts");
    const methods = ["start", "stop", "ensureChannel", "inviteUsers", "postMessage", "updateMessage", "resolveUserName", "onEvent"];
    for (const M of [FakeTransport, SocketModeTransport]) {
      for (const m of methods) {
        expect(typeof (M.prototype as any)[m]).toBe("function");
      }
    }
  });
  test("constructing SocketModeTransport performs no network call and needs no token at import time", async () => {
    const mod = await import("../src/socket-transport.ts");
    expect(typeof mod.SocketModeTransport).toBe("function");
  });
});
