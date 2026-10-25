// ---------------------------------------------------------------------------
// register.ts — the ONLY writer of ~/.liaison/projects.yml (besides ./setup,
// which calls slack-register). The office registry decides where a folder
// talks; sessions never create channels or projects by running slack-say.
//
//   slack-register <abs-path> <name> [--channel <name>]   one project
//   slack-register --office <abs-path> [--channel <name>] the default channel
//
// Why a file at all, rather than deriving names on the fly: the file is the
// shared truth. The daemon reads it to pre-create channels and to route INBOUND
// chat before a project has ever posted; a name that lives only in a session's
// head routes nothing. It also makes a collision detectable.
//
// THE COLLISION RULE: two different folders under the same name (or one Slack
// channel claimed twice) would silently merge two agents' messages into one
// conversation. The second registration is REFUSED, by name and by path.
// Refusing is recoverable; a silently merged channel is not.
// ---------------------------------------------------------------------------
import { readFile, rename, writeFile, open, rm, stat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import type { ProjectConfig } from "./types.ts";
import { bridgePaths, channelForSlug, expandHome, home, pathVariants } from "./paths.ts";
import {
  DEFAULT_OFFICE_CHANNEL, OFFICE_SLUG, parseRegistry, renderOffice, renderProjectEntry, type Registry,
} from "./config.ts";

export interface Registration {
  slug: string;
  channel: string;
  /** the absolute directory the entry is anchored to */
  base: string;
  /** true when this call wrote projects.yml; false when it was already there */
  registered: boolean;
}

/**
 * The registration clashes with an existing entry (same name on another path,
 * a path under another name, or a channel already claimed). The bin script
 * exits 3 for it: the flags were fine, the fix is a different name or a
 * one-line edit to projects.yml.
 */
export class RegisterCollision extends Error {
  readonly code = "register_collision";
  constructor(message: string) {
    super(message);
    this.name = "RegisterCollision";
  }
}

/** Bad input (relative path, invalid name, home directory). The bin script exits 2. */
export class RegisterUsageError extends Error {
  readonly code = "register_usage";
  constructor(message: string) {
    super(message);
    this.name = "RegisterUsageError";
  }
}

const HEADER = `# ~/.liaison/projects.yml
#
# Written by slack-register (and ./setup); the bridge never edits it on its own.
#   office:   the folder the coordinator runs in, and its Slack channel. Every
#             folder NOT listed under projects: talks there.
#   projects: one entry per registered folder. Edit an entry to rename a channel
#             or to point several folders at one channel.
# The daemon re-reads this file live.
`;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CHANNEL_RE = /^[a-z0-9_-]{1,80}$/;
const MAX_NAME = 64;

// ------------------------------------------------------------------ reading

/** The registry in `file`. A missing file is an empty registry; any other read error is an error. */
export async function readRegistry(file: string): Promise<Registry> {
  try { return parseRegistry(await readFile(file, "utf8")); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { office: null, projects: [] };
    throw err;
  }
}

// ------------------------------------------------------------------ validation

/** Absolute, ~-expanded, trailing slashes gone. Relative input is refused. */
function absolutize(p: string): string {
  const expanded = expandHome(p);
  if (!isAbsolute(expanded)) {
    throw new RegisterUsageError(`slack-register needs an absolute path, got ${JSON.stringify(p)}.`);
  }
  return resolvePath(expanded).replace(/\/+$/, "") || "/";
}

function checkChannel(channel: string): void {
  if (!CHANNEL_RE.test(channel)) {
    throw new RegisterUsageError(
      `channel names are lowercase letters, digits, - and _ (max 80 characters), got ${JSON.stringify(channel)}.`,
    );
  }
}

/** A project whose path is `/` or your home directory would claim every folder under it. */
function guardBase(base: string): void {
  if (base === "/" || dirname(base) === base) {
    throw new RegisterUsageError("refusing to register the filesystem root as a project.");
  }
  if (base === home().replace(/\/+$/, "")) {
    throw new RegisterUsageError(
      `refusing to register your home directory (${base}) as a project — every folder under it would share one channel.`,
    );
  }
}

function samePath(a: string, b: string): boolean {
  const bs = new Set(pathVariants(b));
  return pathVariants(a).some((v) => bs.has(v));
}

// --------------------------------------------------------------------- writing

/**
 * Exclusive across processes: two `slack-register` calls at the same instant
 * must not read-then-write over each other. O_EXCL create is the lock; a lock
 * older than STALE_MS is assumed to belong to a process that died.
 */
const STALE_MS = 30_000;

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const fh = await open(lock, "wx");
      try { return await fn(); }
      finally { await fh.close(); await rm(lock, { force: true }); }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > STALE_MS) await rm(lock, { force: true });
      } catch { /* it vanished — that is the good case */ }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`could not acquire ${lock} — remove it if no slack-register is running`);
}

async function readText(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Add the entry at the end of the `projects:` block — wherever that block is,
 * so a hand-edited file with `office:` after it does not swallow the entry.
 */
function insertProject(text: string, entry: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^projects:\s*$/.test(l));
  const block = entry.replace(/^\n/, "").replace(/\n$/, "").split("\n");
  if (at === -1) return `${text.replace(/\n*$/, "\n")}projects:\n${block.join("\n")}\n`;

  let last = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || l.trim().startsWith("#")) continue;
    if (/^\S/.test(l) && !l.startsWith("- ")) break;       // next top-level key
    last = i;
  }
  lines.splice(last + 1, 0, "", ...block);
  return lines.join("\n");
}

/** Put the `office:` block in place: replace an existing one, else sit above `projects:`. */
function spliceOffice(text: string, block: string): string {
  const lines = text.split("\n");
  const add = block.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((l) => /^office:\s*$/.test(l));
  if (at !== -1) {
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]!)) end++;
    lines.splice(at, end - at, ...add);
    return lines.join("\n");
  }
  const proj = lines.findIndex((l) => /^projects:\s*$/.test(l));
  if (proj !== -1) {
    lines.splice(proj, 0, ...add, "");
    return lines.join("\n");
  }
  return `${text.replace(/\n*$/, "\n")}${add.join("\n")}\n`;
}

/** Temp file + rename: the daemon re-reads this file live and must never see half of it. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

function collision(msg: string, file: string): RegisterCollision {
  return new RegisterCollision(
    `${msg}\nTwo folders must not silently share one Slack channel — you would read two agents as one conversation. ` +
    `Pick another name or --channel, or edit ${file} if they really are one project.`,
  );
}

// ---------------------------------------------------------------------- the API

/**
 * Register `path` as project `name`. Idempotent: the identical registration a
 * second time changes nothing and returns `registered:false`. Anything that
 * would put two folders in one channel throws RegisterCollision.
 */
export async function registerProject(root: string, path: string, name: string, channel?: string): Promise<Registration> {
  const base = absolutize(path);
  guardBase(base);
  if (name.length > MAX_NAME || !NAME_RE.test(name)) {
    throw new RegisterUsageError(
      `project names are lowercase letters and digits joined by single hyphens (max ${MAX_NAME}), got ${JSON.stringify(name)}.`,
    );
  }
  if (channel !== undefined) checkChannel(channel);
  const chan = channel ?? channelForSlug(name);
  const file = bridgePaths(root).projectsFile;

  return withLock(file, async () => {
    const reg = await readRegistry(file);
    if (name === OFFICE_SLUG) {
      throw collision(`the name "${OFFICE_SLUG}" is reserved for the office channel.`, file);
    }

    const same = reg.projects.find((p) => p.slug === name);
    if (same) {
      if (same.paths.some((p) => samePath(p, base)) && (channel === undefined || channel === same.channel)) {
        return { slug: name, channel: same.channel, base, registered: false };
      }
      throw collision(
        `the name "${name}" is already registered to ${same.paths.join(", ") || "(no path)"} on #${same.channel}; ` +
        `you asked for ${base} on #${chan}.`, file,
      );
    }
    const claimed = reg.projects.find((p) => p.paths.some((q) => samePath(q, base)));
    if (claimed) {
      throw collision(`${base} is already registered as "${claimed.slug}" (#${claimed.channel}).`, file);
    }
    const clash: ProjectConfig | { slug: string; channel: string } | undefined =
      reg.projects.find((p) => p.channel === chan) ??
      (reg.office?.channel === chan ? { slug: OFFICE_SLUG, channel: chan } : undefined);
    if (clash) throw collision(`the channel #${chan} is already used by "${clash.slug}".`, file);

    const entry = renderProjectEntry({ slug: name, channel: chan, paths: [base] }, new Date().toISOString());
    const text = await readText(file);
    if (!text.trim()) await writeAtomic(file, `${HEADER}projects:\n${entry.replace(/^\n/, "")}`);
    else await writeAtomic(file, insertProject(text, entry));
    return { slug: name, channel: chan, base, registered: true };
  });
}

/**
 * Register the office: the folder the coordinator runs in and the channel every
 * unregistered folder talks to. Idempotent. Registering a different path or
 * channel later replaces the office entry in place.
 */
export async function registerOffice(root: string, path: string, channel?: string): Promise<Registration> {
  const base = absolutize(path);
  if (channel !== undefined) checkChannel(channel);
  const chan = channel ?? DEFAULT_OFFICE_CHANNEL;
  const file = bridgePaths(root).projectsFile;

  return withLock(file, async () => {
    const reg = await readRegistry(file);
    if (reg.office && samePath(reg.office.path, base) && reg.office.channel === chan) {
      return { slug: OFFICE_SLUG, channel: chan, base, registered: false };
    }
    const clash = reg.projects.find((p) => p.channel === chan);
    if (clash) throw collision(`the channel #${chan} is already used by "${clash.slug}".`, file);

    const text = await readText(file);
    const block = renderOffice({ path: base, channel: chan });
    if (!text.trim()) await writeAtomic(file, `${HEADER}${block}projects:\n`);
    else await writeAtomic(file, spliceOffice(text, block));
    return { slug: OFFICE_SLUG, channel: chan, base, registered: true };
  });
}
