# Patch fixer

Auto-fixes and ships Patch items with headless Claude Code, running on the Beelink.
Sibling of the Port daemon — same Supabase project, same `claude -p --permission-mode
bypassPermissions` plumbing, but triggered by the `items` table instead of chat messages.

## Flow

```
new open bug/feature in Patch
  -> daemon polls items (status=open, type in bug/feature, mapped app, created >= watermark)
  -> claims it (status=in_progress)
  -> ensures a clean checkout of the app's repo under CODE_DIR, resets to origin/<default>
  -> runs headless Claude in the repo to FIX it (edits only, no commit)
  -> daemon verifies the build (npm run build if the repo has one)
  -> bumps sw.js cache, commits, pushes the default branch (= GitHub Pages deploy)
  -> writes the outcome back: status=shipped + resolution (commit URL), or needs_info
```

## Autonomy & safety

Nate chose **always auto-ship**. The one hard gate: a change that does **not build** is
never pushed — those flip to `needs_info` with the build error. Other guards:

- `ENABLED` must be `true` or the daemon idles (kill switch).
- Only `bug` / `feature`, only apps in `APP_REPO` (`idea` and the external `resin` app are skipped).
- `.since` watermark: only items created **at/after first boot** are ever touched, so arming
  this does not sweep the existing Patch backlog. `rm server/.since` (on the Beelink) to sweep.
- One item at a time — no two git operations race.
- Per-item hard timeout (`MAX_ITEM_MS`); stuck `in_progress` rows are reaped to `needs_info`.

## App -> repo map

`break`→5-minute-app · `course`→Course-App · `courseplus`→Course-plus-app · `crate`→Crate ·
`cue`→Cue-App · `ink`→Ink · `patch`→Patch-App · `stock`→Stock · `tick`→Habits-App ·
`tide`→Tide-App · `today`→Today-App. `resin` is external (bug capture only) — no repo.

## Deploy (Beelink)

```sh
mkdir -p ~/patchfix && cd ~/patchfix
# copy patch-fixer.mjs + patch-fixer.env.example here
cp patch-fixer.env.example patch-fixer.env && chmod 600 patch-fixer.env
# fill SUPABASE_SERVICE_KEY (from ~/port/port-server.env), set ENABLED=true when ready
set -a; . ./patch-fixer.env; set +a
nohup node patch-fixer.mjs >> patchfix.log 2>&1 &
```

Watch: `tail -f ~/patchfix/patchfix.log`. Disarm: set `ENABLED=false` and restart, or kill the node process.

## DB

Requires an `items.resolution text` column (see `../schema.sql`) — the daemon writes the
one-line outcome there and the Patch UI shows it under shipped / needs_info cards.
