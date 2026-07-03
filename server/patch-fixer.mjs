#!/usr/bin/env node
/**
 * Patch fixer — auto-fixes + ships Patch items with headless Claude Code.
 * Dependency-free (Node 18+ fetch + child_process). Sibling of Port's server.
 *
 * Loop: poll `items` for new open bug/feature rows -> claim (status=in_progress)
 * -> resolve the target app's GitHub repo, ensure a clean checkout under CODE_DIR
 * -> run headless `claude -p <prompt> --permission-mode bypassPermissions` in the
 * repo to FIX the issue (edits only, no commit) -> daemon verifies the build ->
 * bumps sw.js cache, commits, pushes to the default branch (= deploy) -> writes
 * the outcome back onto the item (status=shipped + resolution, or needs_info).
 *
 * Autonomy: Nate chose "always auto-ship". The ONLY gate is: a change that does
 * not build is never pushed (a broken build to GitHub Pages breaks the live app).
 * Those flip to needs_info with the build error instead.
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

// Build a fix brief from the typed Patch fields.
function buildPrompt(it) {
  const L = [];
  const type = it.type || "bug";
  L.push(`You are fixing a ${type} in this repo (the live app deploys from the default branch on push).`);
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
  L.push("Instructions:");
  L.push("- Investigate, then make the minimal correct change. Match surrounding style.");
  L.push("- Edit files ONLY. Do NOT run git commit, git push, or bump any service-worker cache — the deploy pipeline handles that.");
  L.push("- If this is a build/Vite app, you may run the build to check your work, but do not commit build output unless the repo already tracks it.");
  L.push("- If you cannot reproduce it, it needs more info, or no code change is warranted, make NO edits.");
  L.push("");
  L.push('When done, output EXACTLY ONE final line of JSON (nothing after it):');
  L.push('PATCHFIX_RESULT: {"outcome":"fixed|cant_reproduce|needs_info|no_change","summary":"<one sentence>"}');
  return L.join("\n");
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

    const diff = await sh("git", ["status", "--porcelain"], { cwd: dir });
    const changed = !!(diff.out || "").trim();

    if (!run.ok && !changed) {
      await finish(it.id, { status: "needs_info", resolution: `Claude run failed: ${summary.slice(0, 400)}` });
      return;
    }
    if (verdict && verdict.outcome && verdict.outcome !== "fixed") {
      await discard(dir);
      await finish(it.id, { status: "needs_info", resolution: `${verdict.outcome}: ${summary.slice(0, 400)}` });
      return;
    }
    if (!changed) {
      await finish(it.id, { status: "needs_info", resolution: `No changes made: ${summary.slice(0, 400)}` });
      return;
    }

    const build = await verifyBuild(dir);
    if (!build.ok) {
      await discard(dir);
      await finish(it.id, { status: "needs_info", resolution: `Build failed, not shipped. ${build.log.slice(-600)}` });
      return;
    }

    await bumpServiceWorker(dir);
    const title = (it.title || it.where_in_app || summary).slice(0, 60);
    const msg = `${it.type}: ${title} (patch auto-fix ${short})\n\n${summary}\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
    await sh("git", ["add", "-A"], { cwd: dir });
    const commit = await sh("git", ["commit", "-m", msg], { cwd: dir });
    if (commit.code !== 0) { await finish(it.id, { status: "needs_info", resolution: `commit failed: ${(commit.err || commit.out).slice(-300)}` }); return; }
    const push = await sh("git", ["push", "origin", branch], { cwd: dir, timeout: 120000 });
    if (push.code !== 0) { await finish(it.id, { status: "needs_info", resolution: `push failed: ${(push.err || push.out).slice(-300)}` }); return; }

    const sha = (await sh("git", ["rev-parse", "--short", "HEAD"], { cwd: dir })).out.trim();
    const url = `https://github.com/${GH_OWNER}/${repo}/commit/${sha}`;
    await finish(it.id, { status: "shipped", resolution: `${summary.slice(0, 300)} · ${repo}@${sha} ${url}` });
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
