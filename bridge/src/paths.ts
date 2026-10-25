import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MAX_CHANNEL = 80;
/** Keeps `liaison-<slug>` inside MAX_CHANNEL and the slug usable as a directory name. */
const MAX_SLUG = 64;

/**
 * `~/code/my-app` -> `/home/me/code/my-app`.
 *
 * projects.yml is hand-editable, and a hand-written `~` that silently failed to
 * match would route the folder to the office instead of its project. Expand on
 * the way in instead.
 */
export function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return home();
  if (t.startsWith("~/")) return join(home(), t.slice(2));
  return t;
}

/**
 * $HOME first, os.homedir() second. Not interchangeable: bun caches
 * os.homedir(), and a service manager (launchd, systemd) gives the daemon its
 * HOME through its unit/plist rather than through a login shell. $HOME is the
 * one both agree on.
 */
export function home(): string {
  return process.env["HOME"] || homedir();
}

/** /home/me/My.App.Workflows -> my-app-workflows */
export function slugForPath(absPath: string): string {
  const name = basename(absPath.replace(/\/+$/, ""));
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return slug || "default";
}

/** Slack channel for a project. Slack caps names at 80 chars. */
export function channelForSlug(slug: string): string {
  return `liaison-${slug}`.slice(0, MAX_CHANNEL).replace(/-+$/, "");
}

const MAX_FILENAME = 180;

/**
 * Slack-supplied file names are attacker-controlled (the sender is anyone who
 * can post in the channel). `basename` first strips any `../` or `/` a hostile
 * name tried to smuggle in, then only a safe character set survives, so the
 * result can never escape `~/.liaison/<slug>/files/`.
 */
export function sanitizeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/, "");                 // no leading dot (hidden files / "..")
  const safe = cleaned.slice(0, MAX_FILENAME);
  return safe || "file";
}

/**
 * Every spelling of one directory that could appear in projects.yml: the path
 * as written, and its realpath. /tmp and /private/tmp are the same directory on
 * macOS, and which one you get depends on whether the string came from
 * `mkdtemp` (symlinked) or from `git rev-parse` (resolved). Comparing only one
 * of them registers the same repo twice and then refuses it as a collision —
 * caught by the smoke run, not by any unit test.
 */
export function pathVariants(p: string): string[] {
  const base = expandHome(p).replace(/\/+$/, "");
  if (!base) return [];
  try {
    const real = realpathSync(base).replace(/\/+$/, "");
    return real === base ? [base] : [base, real];
  } catch {
    return [base];                       // does not exist (yet): the literal is all there is
  }
}

export interface BridgePaths {
  root: string;
  envFile: string;
  projectsFile: string;
  stateFile: string;
  logDir: string;
  projectDir(slug: string): string;
  inbox(slug: string): string;
  outbox(slug: string): string;
  cursor(slug: string): string;
  filesDir(slug: string): string;
  /** acked slack_ts values, one per line — what `slack-ack --last` has already reacted to */
  ackedFile(slug: string): string;
  /**
   * The bridge's OWN backfill cursor — never a consumer's `.cursor.<reader>`
   * file (those belong to inbox readers, not to the daemon's own Slack
   * history catch-up, and using one would mean two unrelated things racing
   * over the same byte offset).
   */
  bridgeCursor(slug: string): string;
}

/**
 * All protocol paths. `LIAISON_ROOT` relocates the whole tree, which is
 * what lets the bin/ scripts, the daemon and the smoke run agree on a root
 * without any of them hard-coding $HOME.
 */
export function bridgePaths(root?: string): BridgePaths {
  const r = root ?? process.env["LIAISON_ROOT"] ?? join(home(), ".liaison");
  return {
    root: r,
    envFile: join(r, ".env"),
    projectsFile: join(r, "projects.yml"),
    stateFile: join(r, "state.json"),
    logDir: join(r, "logs"),
    projectDir: (slug) => join(r, slug),
    inbox: (slug) => join(r, slug, "inbox.jsonl"),
    outbox: (slug) => join(r, slug, "outbox.jsonl"),
    cursor: (slug) => join(r, slug, ".cursor"),
    filesDir: (slug) => join(r, slug, "files"),
    ackedFile: (slug) => join(r, slug, ".acked"),
    bridgeCursor: (slug) => join(r, slug, ".bridge-cursor"),
  };
}
