#!/usr/bin/env node
/**
 * Patch fixer — auto-fixes + ships Patch items with headless Claude Code.
 * Dependency-free (Node 18+ fetch + child_process). Sibling of Port's server.
 *
 * Loop: poll `items` for new open bug/feature rows -> claim (status=in_progress)
 * -> resolve the target app's GitHub repo, ensure a clean checkout under CODE_DIR
 * -> run headless `claude -p <prompt> --permission-mode bypassPermissions` to
 * TRIAGE then (only if simple) FIX the issue -> if it fixed & builds, bump sw.js,
 * commit, push the default branch (= deploy) -> writeback status=shipped.
 *
 * Triage gate (the autonomy dial): the same Claude run first judges the item
 * SIMPLE vs COMPLEX. SIMPLE = clear, localized, low-risk, no product/design
 * decisions -> it makes the fix and the daemon auto-ships it. COMPLEX (ambiguous
 * scope, needs a decision, risky, or Claude isn't confident) -> it makes NO edits
 * and writes a brief; the daemon opens a Port session (a phone-driveable
 * port_sessions row) aimed at the repo, seeds it with the patch + brief, pings
 * the phone, and marks the item needs_info. So: simple -> ship, complex -> phone.
 *
 * Escalation is unified: anything that can't ship cleanly unattended (complex,
 * or a "simple" fix that then fails to build) becomes a Port session for Nate
 * to drive, instead of being silently dropped. Only a clean fix-that-builds ever
 * reaches the live app. A phone push fires on every outcome (ship / needs-you).
 *
 * Safety:
 *   - ENABLED must be "true" or the daemon idles (kill switch).
 *   - Only type in (bug, feature) and apps present in APP_REPO. idea / resin skip.
 *   - `.since` watermark: only items created at/after first boot are touched, so
 *     turning this on does NOT sweep the whole existing backlog. rm the file to sweep.
 *   - Serialized (one item at a time) — no two git operations race.
 *   - Per-item hard timeout; stuck in_progress rows are reaped to needs_info.
 *
 * Env (see patch-fixer.env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   (service_role; trusted server)
 *   OWNER_ID                              (unused for RLS here; kept for parity)
 *   GH_OWNER            default nates123-cmd
 *   CODE_DIR            default ~/code
 *   CLAUDE_BIN          default ~/.local/bin/claude
 *   PERMISSION_MODE     default bypassPermissions
 *   ENABLED             "true" to actually run (default off)
 *   POLL_MS             default 15000
 *   MAX_ITEM_MS         default 1500000 (25m hard cap per item)
 *   SINCE_FILE          default <this dir>/.since
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = need("SUPABASE_URL");
const KEY = need("SUPABASE_SERVICE_KEY");
const GH_OWNER = process.env.GH_OWNER || "nates123-cmd";
const CODE_DIR = process.env.CODE_DIR || join(homedir(), "code");
const CLAUDE = process.env.CLAUDE_BIN || join(homedir(), ".local/bin/claude");
const PERM = process.env.PERMISSION_MODE || "bypassPermissions";
const ENABLED = (process.env.ENABLED || "").toLowerCase() === "true";
const POLL_MS = +(process.env.POLL_MS || 15000);
const MAX_ITEM_MS = +(process.env.MAX_ITEM_MS || 1500000);
const SINCE_FILE = process.env.SINCE_FILE || join(HERE, ".since");
// Owner + Port handoff. When an item is judged COMPLEX (needs decisions) or a
// "simple" fix fails to build, the daemon does NOT ship — it opens a Port
// session (a row in port_sessions the phone PWA lists) aimed at the repo, seeds
// it with the patch context + triage analysis, and pings the phone. Same
// Supabase project as Port, so this daemon writes those rows directly.
const OWNER = process.env.OWNER_ID || "24c79501-4011-46c9-a3d3-a716d732d69c";
const PUSH_SECRET = process.env.PORT_PUSH_SECRET || "";
const PUSH_URL = process.env.PORT_PUSH_URL || `${URL}/functions/v1/port-push`;
// Ping the phone on every clean auto-ship too (not just on escalations).
const NOTIFY_SHIPS = (process.env.NOTIFY_SHIPS || "true").toLowerCase() === "true";

// Patch app slug -> GitHub repo (github.com/GH_OWNER/<repo>). resin is an external
// app tracked for bug capture only — no repo, never auto-fixed.
const APP_REPO = {
  break: "5-minute-app",
  course: "Course-App",
  courseplus: "Course-plus-app",
  crate: "Crate",
  cue: "Cue-App",
  ink: "Ink",
  patch: "Patch-App",
  stock: "Stock",
  tick: "Habits-App",
  tide: "Tide-App",
  today: "Today-App",
};

function need(k) { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(1); } return v; }
function log(...a) { console.log(new Date().toISOString(), ...a); }

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`sb ${method} ${path} -> ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Run a shell command, capture stdout/stderr, resolve {code, out, err}. Never rejects.
function sh(cmd, args, { cwd, timeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: cwd || CODE_DIR, env: process.env });
    let out = "", err = "";
    const killer = timeout ? setTimeout(() => child.kill("SIGKILL"), timeout) : null;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => { if (killer) clearTimeout(killer); resolve({ code, out, err }); });
    child.on("error", (e) => { if (killer) clearTimeout(killer); resolve({ code: -1, out, err: String(e) }); });
  });
}

// Headless Claude run. Returns { ok, text } where text is the final result string.
function runClaude({ prompt, cwd }) {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", PERM,
      "--allowedTools", "Edit,Write,Read,Bash,Grep,Glob,MultiEdit",
    ];
    const child = spawn(CLAUDE, args, { cwd, env: process.env });
    let buf = "", finalText = "", isError = false, errText = "", timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MAX_ITEM_MS);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "result") {
          if (typeof ev.result === "string" && ev.result) finalText = ev.result;
          isError = !!ev.is_error;
        }
      }
    });
    child.stderr.on("data", (d) => (errText += d.toString()));
    child.on("close", (code) => {
      clearTimeout(killer);
      if (timedOut) return resolve({ ok: false, text: (finalText || "") + "\n[hit MAX_ITEM_MS timeout]" });
      const ok = !isError && finalText !== "";
      resolve({ ok, text: ok ? finalText : (finalText || errText || `claude exited ${code}`).slice(0, 4000) });
    });
  });
}

// Build a triage + fix brief from the typed Patch fields. Claude first decides
// whether the item is a SIMPLE mechanical fix it can safely ship, or a COMPLEX
// one that needs Nate's decisions before any code changes.
function buildPrompt(it) {
  const L = [];
  const type = it.type || "bug";
  L.push(`You are triaging then (if safe) fixing a ${type} in this repo (the live app deploys from the default branch on push).`);
  L.push("");
  if (it.where_in_app) L.push(`Where: ${it.where_in_app}`);
  if (type === "bug") {
    if (it.expected) L.push(`Expected: ${it.expected}`);
    if (it.actual) L.push(`Actual: ${it.actual}`);
    if (it.severity) L.push(`Severity: ${it.severity}`);
  }
  if (it.description) L.push(`Description: ${it.description}`);
  if (it.title) L.push(`Title: ${it.title}`);
  if (it.my_guess) L.push(`My guess at the cause: ${it.my_guess}`);
  if (it.device_context) L.push(`Device: ${it.device_context}`);
  L.push("");
  L.push("STEP 1 — TRIAGE. Investigate the code, then judge this item as SIMPLE or COMPLEX.");
  L.push("SIMPLE = a clear, localized, low-risk change with no product/design judgement calls:");
  L.push("  one obvious cause, a small diff, no ambiguity about the intended behaviour, nothing");
  L.push("  that changes UX, data shape, or copy in a way you'd want a human to approve.");
  L.push("COMPLEX = anything that needs a decision: ambiguous or underspecified scope, multiple");
  L.push("  reasonable approaches, a product/design/UX choice, risky or cross-cutting changes,");
  L.push("  new data model / migration, or you're not confident the requested behaviour is right.");
  L.push("When in doubt, choose COMPLEX. It is far better to hand a borderline item to Nate than to");
  L.push("auto-ship a guess to the live app.");
  L.push("");
  L.push("STEP 2 — ACT on your judgement:");
  L.push("- If SIMPLE: make the minimal correct change now. Match surrounding style. Edit files ONLY.");
  L.push("  Do NOT run git commit / git push / bump any service-worker cache — the pipeline handles that.");
  L.push("  You may run the build to check your work; don't commit build output unless already tracked.");
  L.push("- If COMPLEX: make NO edits. Instead write a short brief for Nate FIRST (plain prose, a few");
  L.push("  lines): what the item is asking, what you found in the code, the options with tradeoffs, and");
  L.push("  the exact decision(s) you need from him. This brief seeds a phone session where he'll drive it.");
  L.push("- If you cannot reproduce it or no code change is warranted: make NO edits and say why.");
  L.push("");
  L.push('When done, output your prose brief (COMPLEX only), THEN exactly one final line of JSON, nothing after it:');
  L.push('PATCHFIX_RESULT: {"outcome":"fixed|complex|cant_reproduce|no_change","summary":"<one sentence>"}');
  L.push('Use outcome "fixed" only when SIMPLE and you actually made the edit; "complex" when it needs Nate\'s decisions.');
  return L.join("\n");
}

// Everything Claude wrote before the final PATCHFIX_RESULT line — used as the
// analysis brief seeded into a Port session for complex / escalated items.
function stripVerdict(text) {
  return (text || "").replace(/PATCHFIX_RESULT:\s*\{.*\}\s*$/s, "").trim();
}

function parseVerdict(text) {
  const m = /PATCHFIX_RESULT:\s*(\{.*\})/s.exec(text || "");
  if (m) { try { const v = JSON.parse(m[1]); if (v && v.outcome) return v; } catch {} }
  return null;
}

// Bump the CACHE/cacheName version string in sw.js so clients pull the new build.
async function bumpServiceWorker(repoDir) {
  const sw = join(repoDir, "sw.js");
  if (!existsSync(sw)) return false;
  let src = await readFile(sw, "utf8");
  // Match a cache-name literal ending in -vNN (e.g. 'patch-v7', "course-plus-v9").
  const re = /(['"`][a-z0-9-]*-v)(\d+)(['"`])/i;
  const m = re.exec(src);
  if (!m) return false;
  const next = (parseInt(m[2], 10) + 1).toString();
  src = src.replace(re, `$1${next}$3`);
  await writeFile(sw, src);
  return true;
}

async function defaultBranch(repoDir) {
  const r = await sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir });
  const b = (r.out || "").trim().replace(/^origin\//, "");
  return b || "main";
}

// Ensure a clean, up-to-date checkout of repo at CODE_DIR/repo on the default branch.
async function ensureRepo(repo) {
  const dir = join(CODE_DIR, repo);
  if (!existsSync(join(dir, ".git"))) {
    log(`clone ${GH_OWNER}/${repo}`);
    const c = await sh("gh", ["repo", "clone", `${GH_OWNER}/${repo}`, dir], { cwd: CODE_DIR, timeout: 180000 });
    if (c.code !== 0) throw new Error(`clone failed: ${(c.err || c.out).slice(0, 300)}`);
  }
  await sh("git", ["fetch", "origin", "--prune"], { cwd: dir, timeout: 120000 });
  const branch = await defaultBranch(dir);
  // Stash anything unexpected so we start from a clean, current default branch.
  const dirty = await sh("git", ["status", "--porcelain"], { cwd: dir });
  if ((dirty.out || "").trim()) {
    await sh("git", ["stash", "push", "-u", "-m", "patchfix-autostash"], { cwd: dir });
  }
  await sh("git", ["checkout", branch], { cwd: dir });
  const pull = await sh("git", ["reset", "--hard", `origin/${branch}`], { cwd: dir });
  if (pull.code !== 0) throw new Error(`reset failed: ${(pull.err || pull.out).slice(0, 300)}`);
  return { dir, branch };
}

// Verify the change builds. Returns { ok, skipped, log }.
async function verifyBuild(dir) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return { ok: true, skipped: true };
  let pkg; try { pkg = JSON.parse(await readFile(pkgPath, "utf8")); } catch { return { ok: true, skipped: true }; }
  if (!pkg.scripts || !pkg.scripts.build) return { ok: true, skipped: true };
  if (!existsSync(join(dir, "node_modules"))) {
    log("npm install");
    const i = await sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeout: 600000 });
    if (i.code !== 0) return { ok: false, log: `npm install failed:\n${(i.err || i.out).slice(-1500)}` };
  }
  log("npm run build");
  const b = await sh("npm", ["run", "build"], { cwd: dir, timeout: 600000 });
  return b.code === 0 ? { ok: true } : { ok: false, log: `build failed:\n${(b.err || b.out).slice(-1500)}` };
}

async function discard(dir) {
  await sh("git", ["reset", "--hard"], { cwd: dir });
  await sh("git", ["clean", "-fd"], { cwd: dir });
}

async function finish(id, fields) {
  if (fields.status === "shipped" || fields.status === "fixed") fields.fixed_at = new Date().toISOString();
  try {
    await sb(`items?id=eq.${id}`, { method: "PATCH", body: fields });
  } catch (e) {
    // Tolerate a DB without the `resolution` column: retry with just the status.
    if (fields.resolution && /resolution/.test(String(e))) {
      const { resolution, ...rest } = fields;
      await sb(`items?id=eq.${id}`, { method: "PATCH", body: rest });
    } else throw e;
  }
}

// Fire a phone push via Port's push edge function. Best-effort — never throws,
// never blocks the pipeline. No-op if PORT_PUSH_SECRET isn't configured.
async function pushNotify(title, body) {
  if (!PUSH_SECRET) return;
  try {
    const r = await fetch(PUSH_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${PUSH_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (!r.ok) log(`push ${title} -> ${r.status}`);
  } catch (e) { log(`push failed: ${String(e).slice(0, 120)}`); }
}

// Hand a complex / un-shippable item to Port: create (or refresh) a named
// port_sessions row aimed at the repo checkout and seed the chat with the patch
// context + Claude's triage brief, so the phone session is warm when Nate opens
// it. Returns the session id. The repo is already clean-checked-out at `dir`
// (= CODE_DIR/repo = the same /home/nate/code/<repo> Port drives from).
async function openPortSession(it, repo, dir, analysis, reason) {
  const short = it.id.slice(0, 8);
  const sid = `patch-${short}`;
  const type = it.type || "bug";
  const title = `${it.app}: ${(it.title || it.where_in_app || it.description || short).replace(/\s+/g, " ").slice(0, 44)}`;

  const ctx = [];
  if (it.where_in_app) ctx.push(`Where: ${it.where_in_app}`);
  if (type === "bug") {
    if (it.expected) ctx.push(`Expected: ${it.expected}`);
    if (it.actual) ctx.push(`Actual: ${it.actual}`);
    if (it.severity) ctx.push(`Severity: ${it.severity}`);
  }
  if (it.description) ctx.push(`Description: ${it.description}`);
  if (it.my_guess) ctx.push(`My guess: ${it.my_guess}`);
  if (it.device_context) ctx.push(`Device: ${it.device_context}`);

  const seed = [
    `You're in the ${repo} repo on the Beelink. A Patch item (${type}/${it.app}) was auto-triaged as NEEDS DECISIONS — ${reason}. It was NOT auto-fixed; it needs Nate's input before any code change.`,
    "",
    "PATCH ITEM:",
    ctx.join("\n"),
    "",
    "AUTO-TRIAGE ANALYSIS:",
    analysis || "(no analysis captured)",
    "",
    `Re-orient in the code, then walk Nate through the options and the exact decisions you need. Once he decides, implement it and ship (bump sw.js, commit "${type}: <title> (patch #${short})", push the default branch). This is Patch item ${it.id}.`,
  ].join("\n");

  // Upsert the session row (idempotent on re-run of the same item).
  await sb("port_sessions?on_conflict=id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      id: sid, user_id: OWNER, project: title, title,
      cwd: dir, claude_session_id: null, state: "idle",
    },
  });
  // Clear any prior seed for this session, then seed fresh.
  await sb(`port_messages?session_id=eq.${encodeURIComponent(sid)}`, { method: "DELETE" }).catch(() => {});
  await sb("port_messages", {
    method: "POST", prefer: "return=minimal",
    body: { user_id: OWNER, session_id: sid, role: "user", content: seed },
  });
  log(`item ${short} -> Port session '${sid}'`);
  return { sid, title };
}

async function processItem(it) {
  const short = it.id.slice(0, 8);
  const repo = APP_REPO[it.app];
  if (!repo) { await finish(it.id, { status: "needs_info", resolution: `No repo mapping for app "${it.app}".` }); return; }

  log(`item ${short} ${it.type}/${it.app} -> ${repo}`);
  let dir;
  try {
    const r = await ensureRepo(repo); dir = r.dir; const branch = r.branch;

    const run = await runClaude({ prompt: buildPrompt(it), cwd: dir });
    const verdict = parseVerdict(run.text);
    const summary = (verdict && verdict.summary) || run.text.split("\n").filter(Boolean).slice(-1)[0] || "(no summary)";
    const analysis = stripVerdict(run.text);
    const outcome = verdict && verdict.outcome;

    const diff = await sh("git", ["status", "--porcelain"], { cwd: dir });
    const changed = !!(diff.out || "").trim();
    // Files Claude actually edited, captured BEFORE the build runs — the build
    // (npm install) rewrites others (package-lock.json) and `git add -A` would
    // otherwise sweep that churn into the shipped commit.
    const claudeTouched = new Set(
      (diff.out || "").split("\n").map((l) => l.slice(3).trim()).filter(Boolean)
    );

    // Escalate to a phone-driveable Port session: don't ship, hand it to Nate.
    const escalate = async (reason, brief) => {
      await discard(dir);
      const { title } = await openPortSession(it, repo, dir, brief || analysis, reason);
      await finish(it.id, { status: "needs_info", resolution: `Needs decisions -> Port session 'patch-${short}'. ${reason}` });
      await pushNotify(`Needs you: ${title}`, `${reason} - open Port to drive it.`);
      log(`item ${short} ESCALATED (${reason})`);
    };

    // The daemon couldn't even run Claude — surface it, but nothing to drive.
    if (!run.ok && !changed) {
      await finish(it.id, { status: "needs_info", resolution: `Claude run failed: ${summary.slice(0, 400)}` });
      await pushNotify(`Auto-fix stalled: ${it.app}`, summary.slice(0, 120));
      log(`item ${short} STALLED (claude run failed): ${summary.slice(0, 160)}`);
      return;
    }
    // COMPLEX (or any non-"fixed" verdict): needs Nate's decisions -> Port.
    if (outcome === "complex") { await escalate("triaged as complex", analysis); return; }
    if (outcome && outcome !== "fixed") {
      await discard(dir);
      await finish(it.id, { status: "needs_info", resolution: `${outcome}: ${summary.slice(0, 400)}` });
      await pushNotify(`Auto-fix skipped: ${it.app}`, `${outcome}: ${summary.slice(0, 100)}`);
      log(`item ${short} SKIPPED (${outcome}): ${summary.slice(0, 160)}`);
      return;
    }
    // Claimed "fixed" but produced no diff — treat as needing a human look.
    if (!changed) {
      await finish(it.id, { status: "needs_info", resolution: `No changes made: ${summary.slice(0, 400)}` });
      await pushNotify(`Auto-fix made no change: ${it.app}`, summary.slice(0, 120));
      log(`item ${short} NO CHANGE: ${summary.slice(0, 160)}`);
      return;
    }

    // Simple fix that must build clean before it ships. If it doesn't, the
    // change isn't shippable unattended -> escalate to Port instead of dropping.
    const build = await verifyBuild(dir);
    if (!build.ok) {
      await escalate("auto-fix did not build", `A simple fix was attempted but the build failed, so it was not shipped.\n\n${analysis}\n\nBuild error:\n${build.log.slice(-800)}`);
      return;
    }

    // Drop build-only churn: revert tracked files the build mutated that Claude
    // never touched, so the commit contains the fix and nothing else.
    for (const line of (await sh("git", ["status", "--porcelain"], { cwd: dir })).out.split("\n")) {
      const f = line.slice(3).trim();
      if (!f || line.startsWith("??") || claudeTouched.has(f)) continue;
      await sh("git", ["checkout", "--", f], { cwd: dir });
    }

    await bumpServiceWorker(dir);
    const title = (it.title || it.where_in_app || summary).slice(0, 60);
    const msg = `${it.type}: ${title} (patch auto-fix ${short})\n\n${summary}\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
    await sh("git", ["add", "-A"], { cwd: dir });
    const commit = await sh("git", ["commit", "-m", msg], { cwd: dir });
    if (commit.code !== 0) { await escalate("auto-fix could not be committed", `${analysis}\n\ncommit failed:\n${(commit.err || commit.out).slice(-600)}`); return; }

    // origin can move while Claude works (Nate pushes from his Mac), which
    // rejects the push as non-fast-forward. Rebase onto the latest default
    // branch, re-verify the build, and retry once before giving up.
    let push = await sh("git", ["push", "origin", branch], { cwd: dir, timeout: 120000 });
    if (push.code !== 0) {
      log(`item ${short} push rejected — rebasing onto origin/${branch}`);
      await sh("git", ["fetch", "origin", "--prune"], { cwd: dir, timeout: 120000 });
      const rb = await sh("git", ["rebase", `origin/${branch}`], { cwd: dir, timeout: 180000 });
      if (rb.code !== 0) {
        await sh("git", ["rebase", "--abort"], { cwd: dir });
        await escalate("auto-fix conflicts with newer work on the default branch", `${analysis}\n\nRebase conflict:\n${(rb.err || rb.out).slice(-600)}`);
        return;
      }
      const rebuild = await verifyBuild(dir);
      if (!rebuild.ok) { await escalate("auto-fix did not build after rebasing on newer work", `${analysis}\n\n${rebuild.log.slice(-800)}`); return; }
      push = await sh("git", ["push", "origin", branch], { cwd: dir, timeout: 120000 });
      if (push.code !== 0) { await escalate("push still rejected after rebase", `${analysis}\n\npush failed:\n${(push.err || push.out).slice(-600)}`); return; }
      log(`item ${short} pushed after rebase`);
    }

    const sha = (await sh("git", ["rev-parse", "--short", "HEAD"], { cwd: dir })).out.trim();
    const url = `https://github.com/${GH_OWNER}/${repo}/commit/${sha}`;
    await finish(it.id, { status: "shipped", resolution: `${summary.slice(0, 300)} · ${repo}@${sha} ${url}` });
    if (NOTIFY_SHIPS) await pushNotify(`Shipped: ${it.app}`, summary.slice(0, 140));
    log(`item ${short} SHIPPED ${repo}@${sha}`);
  } catch (e) {
    if (dir) await discard(dir).catch(() => {});
    await finish(it.id, { status: "needs_info", resolution: `Error: ${String(e).slice(0, 400)}` }).catch(() => {});
    log(`item ${short} ERROR ${String(e).slice(0, 200)}`);
  }
}

// First boot: stamp a watermark so we only ever touch items logged from now on.
async function since() {
  try { return (await readFile(SINCE_FILE, "utf8")).trim(); }
  catch {
    const now = new Date().toISOString();
    await writeFile(SINCE_FILE, now);
    log(`watermark set — only items created >= ${now} will be auto-fixed. rm ${SINCE_FILE} to sweep the backlog.`);
    return now;
  }
}

// Reap rows stuck in in_progress (a prior run died) back to needs_info so they stop blocking.
async function reap(watermark) {
  const stuck = await sb(`items?status=eq.in_progress&type=in.(bug,feature)&created_at=gte.${encodeURIComponent(watermark)}&select=id,updated_at`);
  for (const s of stuck || []) {
    if (Date.now() - new Date(s.updated_at || 0).getTime() > MAX_ITEM_MS + 120000)
      await finish(s.id, { status: "needs_info", resolution: "Auto-fix run abandoned (daemon restart) — reopen to retry." });
  }
}

async function tick(watermark) {
  await reap(watermark);
  const apps = Object.keys(APP_REPO).map((a) => `"${a}"`).join(",");
  const rows = await sb(`items?status=eq.open&type=in.(bug,feature)&app=in.(${apps})&created_at=gte.${encodeURIComponent(watermark)}&order=created_at.asc&limit=1`);
  const it = (rows || [])[0];
  if (!it) return;
  // Atomic claim: only succeeds while the row is still open.
  const claimed = await sb(`items?id=eq.${it.id}&status=eq.open`, {
    method: "PATCH", prefer: "return=representation", body: { status: "in_progress" },
  });
  if (!claimed || !claimed.length) return; // someone else took it
  await processItem(claimed[0]);
}

const watermark = await since();
log(`[patch-fixer] up. enabled=${ENABLED} repos=${Object.keys(APP_REPO).length} code=${CODE_DIR} claude=${CLAUDE} perm=${PERM} poll=${POLL_MS}ms`);
if (!ENABLED) log("ENABLED != true — idling. Set ENABLED=true in the env and restart to arm.");
for (;;) {
  try { if (ENABLED) await tick(watermark); } catch (e) { console.error("[tick]", String(e).slice(0, 400)); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
