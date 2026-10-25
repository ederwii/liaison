#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// smoke.ts — end-to-end against the FAKE transport, using the REAL entrypoint
// and the REAL bin/ scripts as subprocesses. Proves: boot -> channel created ->
// question routed with buttons in a thread -> click -> inbox line -> say ->
// clean SIGTERM shutdown. Zero network, zero tokens.
// Exit code 0 == every step asserted.
// ---------------------------------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeValue } from "../src/blocks.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OWNER = "U_SMOKE_OWNER";
const root = mkdtempSync(join(tmpdir(), "liaison-smoke-"));
const workdir = join(root, "_repo", "alpha-v2");
mkdirSync(workdir, { recursive: true });

const steps: string[] = [];
let step = 0;
function ok(msg: string): void { steps.push(`  ${String(++step).padStart(2, " ")}. OK   ${msg}`); console.log(steps.at(-1)); }
function fail(msg: string): never {
  console.log(`  ${String(++step).padStart(2, " ")}. FAIL ${msg}`);
  console.log(`\n--- daemon log ---\n${existsSync(logFile) ? readFileSync(logFile, "utf8") : "(none)"}`);
  process.exit(1);
}

writeFileSync(join(root, "projects.yml"), `projects:
  - slug: alpha-v2
    channel: liaison-alpha-v2
    paths:
      - ${workdir}
`);

const logFile = join(root, "daemon.log");
const logFd = Bun.file(logFile);
const proc = Bun.spawn(["bun", join(REPO, "src", "index.ts")], {
  env: { ...process.env, LIAISON_ROOT: root, LIAISON_FAKE: "1",
         LIAISON_OWNER_USER_IDS: OWNER, LIAISON_PUMP_MS: "100", LIAISON_TICK_MS: "200" },
  stdout: "pipe", stderr: "pipe",
});

// mirror daemon stdout to a file we can read while it runs
let logBuf = "";
(async () => { for await (const c of proc.stdout) { logBuf += new TextDecoder().decode(c); writeFileSync(logFile, logBuf); } })();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => T | undefined, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) fail(`${what} (timed out after ${ms}ms)`);
    await sleep(50);
  }
}
const readJsonl = (f: string): any[] =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const posts = () => readJsonl(join(root, "_fake_posts.jsonl"));
const inbox = () => readJsonl(join(root, "alpha-v2", "inbox.jsonl"));
const emit = (e: unknown) => appendFileSync(join(root, "_fake_in.jsonl"), JSON.stringify(e) + "\n");

async function runIn(cwd: string, cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, LIAISON_ROOT: root, HOME: root }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
}
const run = (cmd: string[]) => runIn(workdir, cmd);

console.log(`\nliaison bridge smoke run (fake transport)\n  root: ${root}\n`);

// 1 — the daemon boots
await waitFor("daemon reports ready", () => (logBuf.includes('"msg":"ready"') ? true : undefined));
ok("daemon booted and reported ready (fake transport, no tokens read)");

// 2 — slack-ask from the project cwd
const ask = await run([join(REPO, "bin", "slack-ask"), "Ship the release tonight? A = ship, B = hold, C = ask again later",
  "--type", "buttons", "--options", "A,B,C", "--timeout", "30m", "--default", "B"]);
if (ask.code !== 0) fail(`slack-ask exited ${ask.code}: ${ask.err}`);
const qid = ask.out;
if (!qid.startsWith("q_")) fail(`slack-ask printed ${JSON.stringify(qid)}, expected a question id`);
ok(`slack-ask returned question id ${qid} and exited 0 (did NOT wait)`);

// 3 — the daemon created the channel and posted parent + threaded buttons
const parent = await waitFor("question posted", () => posts().find((p) => p.kind === "post" && p.text.includes("Ship the release tonight?")));
ok(`channel created by the daemon, question posted: ${JSON.stringify(parent.text.split("\n")[0])}`);
const blocks = await waitFor("buttons posted in thread", () => posts().find((p) => p.kind === "post" && p.threadTs === parent.ts && p.blocks));
const buttons = (blocks.blocks as any[]).flatMap((b) => b.elements ?? []);
if (buttons.length !== 3) fail(`expected 3 buttons in the thread, got ${buttons.length}`);
ok(`3 buttons live IN THE THREAD (thread_ts ${parent.ts}): ${buttons.map((b: any) => b.text.text).join(" | ")}`);

// 4 — a click from a NON-allowlisted user must be ignored
emit({ type: "action", channel: parent.channel, user: "U_INTRUDER", ts: "1.1",
       threadTs: parent.ts, actionId: "sb_choice", value: buttons[0].value });
await sleep(400);
if (inbox().length !== 0) fail("a non-allowlisted click reached the inbox");
await waitFor("intruder logged", () => (logBuf.includes('"not_allowlisted"') ? true : undefined));
ok("click from a non-allowlisted user: ignored + logged, inbox untouched");

// 5 — the owner clicks "A"
const shipBtn = buttons.find((b: any) => decodeValue(b.value)?.o === "A");
emit({ type: "action", channel: parent.channel, user: OWNER, ts: "1700000999.000100",
       threadTs: parent.ts, actionId: "sb_choice", value: shipBtn.value });
const answer = await waitFor("answer in inbox", () => inbox().find((l) => l.kind === "answer" && l.question_id === qid));
ok(`inbox line: ${JSON.stringify({ kind: answer.kind, choice: answer.choice, answered_by: answer.answered_by, via: answer.via, authority: answer.authority })}`);

// 6 — the session reads it with the real bin script
const read = await run([join(REPO, "bin", "slack-inbox"), "--question", qid]);
if (read.code !== 0) fail(`slack-inbox exited ${read.code}`);
ok(`slack-inbox --question ${qid} returned the answer (exit 0)`);

// 7 — buttons are dead afterwards
await waitFor("buttons disabled", () => posts().find((p) => p.kind === "update" && p.ts === blocks.ts));
ok("buttons replaced with a settled summary — the question cannot be answered twice");

// 8 — bidirectional: owner types in the channel, session replies with slack-say
emit({ type: "message", channel: parent.channel, user: OWNER, text: "why tonight?", ts: "1700001000.000100" });
const chat = await waitFor("chat line in inbox", () => inbox().find((l) => l.kind === "message" && l.text === "why tonight?"));
ok(`free chat routed to the project inbox: ${JSON.stringify(chat.text)}`);
const said = await run([join(REPO, "bin", "slack-say"), "because the CDN cache expires at 03:00"]);
if (said.code !== 0) fail(`slack-say exited ${said.code}: ${said.err}`);
await waitFor("reply posted", () => posts().find((p) => p.kind === "post" && p.text.includes("CDN cache expires")));
ok("slack-say posted the reply back to the same channel — round trip closed");

// 9 — REGISTRY ROUTING, against the LIVE daemon. The daemon is still the
// process booted in step 1 — it is never restarted here. That is the whole
// claim: `slack-register` writes the file and the daemon picks it up.
const reg = join(REPO, "bin", "slack-register");
const demoRoot = join(root, "_repo", "outer", "demo-project");
mkdirSync(join(demoRoot, "src", "deep"), { recursive: true });

// 9a — an unregistered folder with no office configured is refused, not guessed.
const noOffice = await runIn(join(demoRoot, "src", "deep"), [join(REPO, "bin", "slack-say"), "nobody home"]);
if (noOffice.code !== 4) fail(`slack-say with no office exited ${noOffice.code}, expected 4: ${noOffice.err}`);
if (!noOffice.err.includes("./setup")) fail(`the refusal did not point at ./setup: ${noOffice.err}`);
ok("unregistered folder + no office: refused with exit 4, pointing at ./setup");

// 9b — register the project; a say from a subfolder lands in its own new channel.
const regDemo = await runIn(root, [reg, demoRoot, "demo-project"]);
if (regDemo.code !== 0 || !regDemo.out.includes("registered demo-project -> #liaison-demo-project")) {
  fail(`slack-register exited ${regDemo.code}: ${regDemo.out} ${regDemo.err}`);
}
const routed = await runIn(join(demoRoot, "src", "deep"), [join(REPO, "bin", "slack-say"), "registry routing works"]);
if (routed.code !== 0) fail(`slack-say in a registered project exited ${routed.code}: ${routed.err}`);
await waitFor("daemon created the registered channel without a restart",
  () => (logBuf.includes('"msg":"channel_created"') && logBuf.includes('"channel":"liaison-demo-project"') ? true : undefined));
if (!logBuf.includes('"msg":"owner_invited"')) fail("the allowlist was not invited into the new channel");
const routedPost = await waitFor("say delivered", () => posts().find((p) => p.kind === "post" && p.text.includes("registry routing works")));
if (routedPost.channel === parent.channel) fail("the new project posted into the OLD project's channel");
ok("live daemon (never restarted) created #liaison-demo-project, invited the allowlist, delivered the say from src/deep");

// 9c — register the office; an unregistered folder now talks there, and nothing is written.
const stray = join(root, "_repo", "stray");
mkdirSync(stray, { recursive: true });
const regOffice = await runIn(root, [reg, "--office", join(root, "_repo", "office")]);
if (regOffice.code !== 0) fail(`slack-register --office exited ${regOffice.code}: ${regOffice.err}`);
const ymlBefore = readFileSync(join(root, "projects.yml"), "utf8");
const toOffice = await runIn(stray, [join(REPO, "bin", "slack-say"), "to the office"]);
if (toOffice.code !== 0) fail(`slack-say from an unregistered folder exited ${toOffice.code}: ${toOffice.err}`);
const officePost = await waitFor("office say delivered", () => posts().find((p) => p.kind === "post" && p.text.includes("to the office")));
if (officePost.channel === parent.channel || officePost.channel === routedPost.channel) fail("the office say went to a project channel");
if (readFileSync(join(root, "projects.yml"), "utf8") !== ymlBefore) fail("slack-say rewrote projects.yml");
if (!logBuf.includes('"channel":"liaison-office"')) fail("the daemon did not create #liaison-office");
ok("unregistered folder -> #liaison-office; projects.yml untouched by slack-say");

// 10 — a name collision is refused with exit 3, and nothing is written
const clashRoot = join(root, "_repo", "other", "demo-project");
mkdirSync(clashRoot, { recursive: true });
const clash = await runIn(root, [reg, clashRoot, "demo-project"]);
if (clash.code !== 3) fail(`a colliding slack-register exited ${clash.code}, expected 3`);
if (!clash.err.includes(demoRoot)) fail(`the refusal did not name the incumbent path: ${clash.err}`);
if ((readFileSync(join(root, "projects.yml"), "utf8").match(/- slug: demo-project/g) ?? []).length !== 1) {
  fail("the refused project was written to projects.yml anyway");
}
ok("a second folder under the same name: refused, exit 3, nothing written");

// 11 — clean shutdown
proc.kill("SIGTERM");
const code = await proc.exited;
await sleep(100);
if (code !== 0) fail(`daemon exited ${code} on SIGTERM, expected 0`);
if (!logBuf.includes('"msg":"stopped"')) fail("daemon did not log a clean stop");
ok("SIGTERM -> graceful shutdown, exit code 0");

// 12 — nothing token-shaped anywhere in the logs
if (/xox[bpsa]-|xapp-/.test(logBuf)) fail("a token-shaped string appeared in the daemon log");
ok("no token-shaped string in any log line");

console.log(`\nSMOKE PASS — ${step} steps\n`);
