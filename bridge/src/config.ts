import type { ProjectConfig } from "./types.ts";
import { channelForSlug, expandHome, pathVariants } from "./paths.ts";

export interface DaemonConfig {
  root: string;
  /** read at BOOT ONLY. Restart the daemon to reload. */
  allowedUserIds: string[];
  projects: ProjectConfig[];
  dryRun: boolean;
}

/** The reserved project name (and inbox/outbox directory) of the office channel. */
export const OFFICE_SLUG = "office";
export const DEFAULT_OFFICE_CHANNEL = "liaison-office";

/** Where unregistered folders talk: the folder the coordinator runs in, and its channel. */
export interface OfficeConfig {
  path: string;
  channel: string;
}

/** Everything projects.yml declares. */
export interface Registry {
  office: OfficeConfig | null;
  projects: ProjectConfig[];
}

/**
 * Nobody registered this folder and there is no office to fall back to. The
 * CLI exits 4 for it: the caller did nothing wrong with their flags, setup has
 * simply not been run.
 */
export class OfficeNotConfigured extends Error {
  readonly code = "office_not_configured";
  constructor() {
    super("this folder is not registered and no office channel is configured. Run ./setup in the liaison repo.");
    this.name = "OfficeNotConfigured";
  }
}

/**
 * Tiny YAML reader for projects.yml. Deliberately not a YAML dependency: the
 * file has exactly one shape and a parser we own cannot surprise us.
 *
 *   office:
 *     path: /home/me/liaison-office
 *     channel: liaison-office
 *   projects:
 *     - slug: my-app
 *       channel: liaison-my-app
 *       paths:
 *         - /home/me/code/my-app
 *
 * Unknown keys are ignored. An `office:` block without a `path:` is ignored.
 */
export function parseRegistry(text: string): Registry {
  const out: ProjectConfig[] = [];
  let current: Partial<ProjectConfig> | null = null;
  let office: { path?: string; channel?: string } | null = null;
  let section: "projects" | "office" | "other" = "projects";
  let inPaths = false;
  let inAdmins = false;

  const flush = () => {
    if (current?.slug) {
      out.push({
        slug: current.slug,
        channel: current.channel ?? channelForSlug(current.slug),
        paths: current.paths ?? [],
        // Only when declared: reloadProjects() diffs the registry with
        // JSON.stringify, so an unrequested key would look like a change.
        ...(current.admins && current.admins.length ? { admins: current.admins } : {}),
      });
    }
    current = null;
    inPaths = false;
    inAdmins = false;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    // A top-level key starts a section.
    if (indent === 0 && !body.startsWith("- ") && body.includes(":")) {
      flush();
      const key = body.slice(0, body.indexOf(":")).trim();
      section = key === "projects" ? "projects" : key === "office" ? "office" : "other";
      if (section === "office") office = office ?? {};
      continue;
    }
    if (section === "office") {
      const kv = splitKv(body);
      if (kv && office) {
        if (kv[0] === "path") office.path = expandHome(kv[1]);
        else if (kv[0] === "channel") office.channel = kv[1];
      }
      continue;
    }
    if (section === "other") continue;

    if (body.startsWith("- ")) {
      const item = body.slice(2).trim();
      if (inPaths && indent > 4) { current!.paths = [...(current!.paths ?? []), unquote(item)]; continue; }
      if (inAdmins && indent > 4) { current!.admins = [...(current!.admins ?? []), unquote(item)]; continue; }
      flush();
      current = {};
      const kv = splitKv(item);
      if (kv) assign(current, kv[0], kv[1]);
      continue;
    }
    if (!current) continue;
    const kv = splitKv(body);
    if (!kv) continue;
    if (kv[0] === "paths" && kv[1] === "") { inPaths = true; inAdmins = false; current.paths = current.paths ?? []; continue; }
    if (kv[0] === "admins" && kv[1] === "") { inAdmins = true; inPaths = false; continue; }
    inPaths = false;
    inAdmins = false;
    assign(current, kv[0], kv[1]);
  }
  flush();
  return {
    office: office?.path ? { path: office.path, channel: office.channel || DEFAULT_OFFICE_CHANNEL } : null,
    projects: out,
  };
}

/** Just the `projects:` entries. */
export function parseProjectsYml(text: string): ProjectConfig[] {
  return parseRegistry(text).projects;
}

/**
 * What the daemon routes: every project, plus the office as one more project
 * (slug "office"), so its channel is ensured at boot and on file change and
 * its outbox/inbox are served like any other.
 */
export function daemonProjects(reg: Registry): ProjectConfig[] {
  return reg.office
    ? [...reg.projects, { slug: OFFICE_SLUG, channel: reg.office.channel, paths: [reg.office.path] }]
    : reg.projects;
}

function splitKv(s: string): [string, string] | null {
  const i = s.indexOf(":");
  if (i === -1) return null;
  return [s.slice(0, i).trim(), unquote(s.slice(i + 1).trim())];
}
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
function assign(p: Partial<ProjectConfig>, k: string, v: string): void {
  if (k === "slug") p.slug = v;
  else if (k === "channel") p.channel = v;
  else if (k === "path") p.paths = [...(p.paths ?? []), expandHome(v)];
  // inline form: `admins: U1, U2`
  else if (k === "admins") p.admins = [...(p.admins ?? []), ...v.split(",").map((x) => x.trim()).filter(Boolean)];
}

/**
 * Serialise ONE project as the yml block `slack-register` appends. Written by
 * hand rather than by a yaml library for the same reason the parser is: this
 * file has exactly one shape, and a dependency that reformats the owner's
 * comments on every write is a dependency that loses their notes.
 *
 * It writes only slug, channel and paths. Pinned by test/registry-shape.test.ts.
 */
export function renderProjectEntry(p: ProjectConfig, stamp: string): string {
  const lines = [
    `  # registered ${stamp}`,
    `  - slug: ${p.slug}`,
    `    channel: ${p.channel}`,
    "    paths:",
    ...p.paths.map((path) => `      - ${path}`),
  ];
  return `\n${lines.join("\n")}\n`;
}

/** The `office:` block, ending in a newline. */
export function renderOffice(o: OfficeConfig): string {
  return `office:\n  path: ${o.path}\n  channel: ${o.channel}\n`;
}

/**
 * cwd -> project, or null when nobody has claimed this path. Longest
 * PATH-SEGMENT prefix wins, so a sub-repo beats its parent and a sibling
 * directory that merely shares a string prefix (my-app-lab vs my-app)
 * never steals the match.
 *
 * Several candidate spellings of the same directory may be passed — typically
 * the literal cwd and its realpath — because /tmp and /private/tmp are the same
 * directory and only one of them is ever written to the file.
 */
export function matchProject(projects: ProjectConfig[], ...cwds: string[]): ProjectConfig | null {
  const candidates = [...new Set(cwds.flatMap(pathVariants))];
  let best: { p: ProjectConfig; len: number } | null = null;
  for (const p of projects) {
    for (const raw of p.paths) {
      // Both sides are normalised: a config path written as /var/... must match
      // a cwd reported as /private/var/..., and the other way round.
      for (const base of pathVariants(raw)) {
        for (const norm of candidates) {
          if (norm !== base && !norm.startsWith(base + "/")) continue;
          if (!best || base.length > best.len) best = { p, len: base.length };
        }
      }
    }
  }
  return best?.p ?? null;
}

export type ResolvedProject = ProjectConfig & {
  /** true when a registered project claimed the path; false when it fell to the office */
  registered: boolean;
  /** true when the path fell to the office AND is the office folder itself or under it (no "unregistered" warning is due) */
  inOffice: boolean;
};

/**
 * cwd -> where it talks: the longest-prefix registered project, else the
 * office. Throws OfficeNotConfigured when neither exists. PURE: it reads no
 * file and writes none — only `slack-register` and `./setup` change the
 * registry.
 */
export function resolveProject(reg: Registry, cwd: string): ResolvedProject {
  const hit = matchProject(reg.projects, cwd);
  if (hit) return { ...hit, registered: true, inOffice: false };
  if (!reg.office) throw new OfficeNotConfigured();
  const office: ProjectConfig = { slug: OFFICE_SLUG, channel: reg.office.channel, paths: [reg.office.path] };
  return { ...office, registered: false, inOffice: matchProject([office], cwd) !== null };
}

/** KEY=VALUE lines. Values are never logged anywhere in this codebase. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7).trim() : t;
    const i = body.indexOf("=");
    if (i <= 0) continue;
    const key = body.slice(0, i).trim();
    let val = body.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}
