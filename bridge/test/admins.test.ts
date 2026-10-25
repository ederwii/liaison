// ---------------------------------------------------------------------------
// admins.test.ts — per-project admins.
//
// People the owner invites into a project's channel should be obeyed like the
// owner there, while the session can still tell them apart by name.
//
// projects.yml may list `admins:` (Slack user ids) per project. In THAT
// project's channel they are obeyed exactly like the owner; anywhere else they
// are strangers. Every inbox line from a person carries `from_name` + `role`,
// so a session can tell the owner from an admin and address each by name.
// ---------------------------------------------------------------------------
import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { channelId, makeRig, OWNER, type Rig } from "./harness.ts";
import { ACTION_CHOICE, encodeValue } from "../src/blocks.ts";
import { parseProjectsYml } from "../src/config.ts";

const ADMIN = "U_ADMIN";
let rig: Rig | undefined;
afterEach(async () => { if (rig) { await rig.daemon.stop(); rig.cleanup(); rig = undefined; } });

const yml = (withAdmin: boolean): string => `projects:
  - slug: alpha
    channel: liaison-alpha
    paths:
      - /home/me/alpha-v2
  - slug: beta
    channel: liaison-beta
    paths:
      - /home/me/beta
${withAdmin ? `    admins:
      - ${ADMIN}   # Dana Admin
` : ""}`;

async function boot(withAdmin = true): Promise<void> {
  rig = makeRig();
  rig!.tx.userNames.set(ADMIN, "Dana Admin");
  writeFileSync(join(rig!.root, "projects.yml"), yml(withAdmin));
  await rig!.daemon.start();
  await rig!.daemon.pump();
  for (const s of ["alpha", "beta"]) rig!.push(s, { kind: "say", text: "boot" });
  await rig!.daemon.pump();
}

describe("parseProjectsYml admins", () => {
  test("reads the admins list, strips comments, and leaves other projects untouched", () => {
    const p = parseProjectsYml(yml(true));
    expect(p.find((x) => x.slug === "beta")!.admins).toEqual([ADMIN]);
    expect("admins" in p.find((x) => x.slug === "alpha")!).toBe(false);
    expect(p.find((x) => x.slug === "beta")!.paths).toEqual(["/home/me/beta"]);
  });
});

describe("a project admin is obeyed in its channel only", () => {
  test("accepted in its project, with from_name and role admin", async () => {
    await boot();
    await rig!.tx.say({ channel: channelId(rig!, "beta"), user: ADMIN, text: "ship the post" });
    const lines = rig!.inbox("beta");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "message", from: ADMIN, from_name: "Dana Admin", role: "admin", text: "ship the post" });
  });

  test("rejected in another project", async () => {
    await boot();
    await rig!.tx.say({ channel: channelId(rig!, "alpha"), user: ADMIN, text: "hello" });
    expect(rig!.inbox("alpha")).toHaveLength(0);
    expect(rig!.daemon.logs.some((l) => l.msg === "not_allowlisted")).toBe(true);
  });

  test("the owner's lines say role owner and carry his name", async () => {
    await boot();
    await rig!.tx.say({ channel: channelId(rig!, "beta"), user: OWNER, text: "ok" });
    expect(rig!.inbox("beta")[0]).toMatchObject({ from: OWNER, from_name: "Owner", role: "owner" });
  });

  test("an admin's button answer is an owner-decision, attributed by name", async () => {
    await boot();
    rig!.push("beta", { kind: "ask", question_id: "q1", text: "?", qtype: "buttons", options: ["A", "B"] } as any);
    await rig!.daemon.pump();
    const q = rig!.daemon.openQuestions()[0]!;
    await rig!.tx.clickButton({ channel: q.channel, user: ADMIN, threadTs: q.thread_ts, actionId: ACTION_CHOICE, value: encodeValue("q1", "B") });
    const a = rig!.inbox("beta").find((l) => l.kind === "answer")!;
    expect(a).toMatchObject({
      choice: "B", from: ADMIN, from_name: "Dana Admin", role: "admin",
      answered_by: "Dana Admin", executed_by: "Dana Admin", authority: "owner-decision",
    });
  });

  test("admins are hot-reloaded: added and removed without a restart", async () => {
    await boot(false);
    await rig!.tx.say({ channel: channelId(rig!, "beta"), user: ADMIN, text: "before" });
    expect(rig!.inbox("beta")).toHaveLength(0);

    writeFileSync(join(rig!.root, "projects.yml"), yml(true));
    await rig!.daemon.pump();
    await rig!.tx.say({ channel: channelId(rig!, "beta"), user: ADMIN, text: "after" });
    expect(rig!.inbox("beta").map((l) => l.text)).toEqual(["after"]);

    writeFileSync(join(rig!.root, "projects.yml"), yml(false));
    await rig!.daemon.pump();
    await rig!.tx.say({ channel: channelId(rig!, "beta"), user: ADMIN, text: "removed" });
    expect(rig!.inbox("beta")).toHaveLength(1);
  });

  test("urgent @mentions still go to the owner, never the admin", async () => {
    await boot();
    rig!.push("beta", { kind: "say", text: "fire", urgent: true } as any);
    await rig!.daemon.pump();
    expect(rig!.tx.posts.at(-1)!.text).toContain(OWNER);
    expect(rig!.tx.posts.at(-1)!.text).not.toContain(ADMIN);
  });
});
