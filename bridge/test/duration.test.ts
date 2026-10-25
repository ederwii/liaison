import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/duration.ts";

describe("parseDuration", () => {
  test("parses the suffixes slack-ask accepts", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });
  test("bare number means seconds", () => {
    expect(parseDuration("45")).toBe(45_000);
  });
  test("rejects garbage loudly rather than silently waiting forever", () => {
    expect(() => parseDuration("soon")).toThrow(/duration/i);
    expect(() => parseDuration("-5m")).toThrow(/duration/i);
    expect(() => parseDuration("")).toThrow(/duration/i);
  });
});
