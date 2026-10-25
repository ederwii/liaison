import { describe, expect, test } from "bun:test";
import { SocketLivenessMonitor } from "../src/socket-transport.ts";

// Measured against the installed package: the socket
// goes zombie when it gets stuck Disconnected/Reconnecting without ever
// reaching Connected again, or when the client logs repeated pong timeouts.
// These tests exercise the pure decision logic with a fake clock — no real
// websocket, no network, no process.exit.

function clockMonitor(onFatal: (reason: string, fields: Record<string, unknown>) => void) {
  const clock = { t: 0 };
  const monitor = new SocketLivenessMonitor({ now: () => clock.t, onFatal });
  return { clock, monitor };
}

describe("SocketLivenessMonitor — disconnected/reconnecting held too long", () => {
  test("fires once stuck disconnected past the threshold", () => {
    const calls: { reason: string; fields: Record<string, unknown> }[] = [];
    const { clock, monitor } = clockMonitor((reason, fields) => calls.push({ reason, fields }));

    monitor.disconnected();
    clock.t += 59_000;
    monitor.checkDisconnected();
    expect(calls).toEqual([]); // not yet — 59s < 60s default

    clock.t += 2_000;
    monitor.checkDisconnected();
    expect(calls.length).toBe(1);
    expect(calls[0]?.reason).toBe("disconnected_too_long");
  });

  test("reconnecting() counts toward the same clock as disconnected()", () => {
    const calls: string[] = [];
    const { clock, monitor } = clockMonitor((reason) => calls.push(reason));
    monitor.disconnected();
    clock.t += 30_000;
    monitor.reconnecting(); // does not reset the clock — it is still not Connected
    clock.t += 31_000;
    monitor.checkDisconnected();
    expect(calls).toEqual(["disconnected_too_long"]);
  });

  test("connected() resets the clock — legitimate reconnects never fire", () => {
    const calls: string[] = [];
    const { clock, monitor } = clockMonitor((reason) => calls.push(reason));
    monitor.disconnected();
    clock.t += 45_000;
    monitor.connected();
    clock.t += 45_000;
    monitor.checkDisconnected(); // no disconnectedSince any more
    expect(calls).toEqual([]);
  });

  test("fires at most once (one-shot)", () => {
    const calls: string[] = [];
    const { clock, monitor } = clockMonitor((reason) => calls.push(reason));
    monitor.disconnected();
    clock.t += 120_000;
    monitor.checkDisconnected();
    monitor.checkDisconnected();
    monitor.disconnected();
    expect(calls.length).toBe(1);
  });
});

describe("SocketLivenessMonitor — repeated pong timeouts", () => {
  test("3 pong timeouts inside the window fire; isolated ones do not", () => {
    const calls: { reason: string; fields: Record<string, unknown> }[] = [];
    const { clock, monitor } = clockMonitor((reason, fields) => calls.push({ reason, fields }));

    monitor.pongTimeout();
    clock.t += 1000;
    expect(calls).toEqual([]);
    monitor.pongTimeout();
    clock.t += 1000;
    expect(calls).toEqual([]);
    monitor.pongTimeout();
    expect(calls.length).toBe(1);
    expect(calls[0]?.reason).toBe("pong_timeout_repeated");
    expect(calls[0]?.fields["count"]).toBe(3);
  });

  test("pong timeouts outside the window age out and do not accumulate", () => {
    const calls: string[] = [];
    const { clock, monitor } = clockMonitor((reason) => calls.push(reason));
    monitor.pongTimeout();
    clock.t += 130_000; // past the 120s default window
    monitor.pongTimeout();
    clock.t += 1000;
    monitor.pongTimeout();
    expect(calls).toEqual([]); // only 2 remain in-window
  });

  test("connected() clears pong-timeout history (a real recovery resets the count)", () => {
    const calls: string[] = [];
    const { clock, monitor } = clockMonitor((reason) => calls.push(reason));
    monitor.pongTimeout();
    monitor.pongTimeout();
    monitor.connected();
    clock.t += 1000;
    monitor.pongTimeout();
    expect(calls).toEqual([]); // history cleared — this is pong #1, not #3
  });
});
