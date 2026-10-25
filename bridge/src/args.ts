import { statSync } from "node:fs";
import { OfficeNotConfigured } from "./config.ts";

/** Slack's own file-size ceiling we enforce client-side so a bad --file fails fast, before any token is touched. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** undefined == ok. Otherwise a one-line, user-facing reason the CLI should exit 2 over. */
export function validateAttachment(path: string): string | undefined {
  let st;
  try { st = statSync(path); } catch { return `file not found: ${path}`; }
  if (!st.isFile()) return `not a regular file: ${path}`;
  if (st.size > MAX_ATTACHMENT_BYTES) {
    return `file too large (${st.size} bytes, max ${MAX_ATTACHMENT_BYTES} / 20 MB): ${path}`;
  }
  return undefined;
}

/** Minimal flag parser. No dependency, no surprises. */
export interface Parsed { flags: Record<string, string | true>; positional: string[] }

export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { flags[key] = true; continue; }
    flags[key] = next; i++;
  }
  return { flags, positional };
}

export function str(p: Parsed, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === "string" ? v : undefined;
}
export function bool(p: Parsed, key: string): boolean {
  return p.flags[key] === true || p.flags[key] === "true";
}

const BUTTON_EXAMPLE = "slack-ask 'Which one? A = ship it, B = hold' --type buttons --options 'A,B'";
function buttonGuardError(problem: string): string {
  return `slack-ask: Rule broken: ${problem}\n` +
    `Valid example: ${BUTTON_EXAMPLE}\n` +
    `Nothing was sent.`;
}

/**
 * Guard for --type buttons: buttons are only letters A..H (consecutive from A);
 * the answer text lives in the question, never in the button label.
 * undefined == ok. Otherwise a ready-to-print error (CLI exits 2).
 */
export function validateButtonLetters(text: string, options: string[]): string | undefined {
  if (options.length < 2 || options.some((o) => !/^[A-H]$/.test(o))) {
    return buttonGuardError(
      "--options must be 2+ single uppercase letters A–H (A,B,C…), no words in the button label");
  }
  if (new Set(options).size !== options.length) {
    return buttonGuardError("duplicate letters in --options");
  }
  if (options.some((o, i) => o !== String.fromCharCode(65 + i))) {
    return buttonGuardError("letters must be consecutive starting at A (A,B / A,B,C…)");
  }
  for (const L of options) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${L}\\s*[=):—-]\\s*\\S[^\\S]*\\S[^\\S]*\\S`, "u");
    if (!re.test(text)) {
      return buttonGuardError(
        `the question text must explain the letter "${L}" (e.g. "${L} = do this", at least 3 characters after the sign)`);
    }
  }
  return undefined;
}

/**
 * Exit code for an error a routing verb caught: 4 when the folder is
 * unregistered and no office is configured (run ./setup), else `fallback`.
 */
export function exitCodeFor(err: unknown, fallback = 1): number {
  return err instanceof OfficeNotConfigured ? 4 : fallback;
}
