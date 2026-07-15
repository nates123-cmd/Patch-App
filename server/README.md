# Patch fixer

Auto-**triages** Patch items with headless Claude Code, running on the Beelink: it ships
the simple ones and hands the complex ones to your phone. Sibling of the Port daemon —
same Supabase project, same `claude -p --permission-mode bypassPermissions` plumbing, but
triggered by the `items` table instead of chat messages.

## Flow

```
new open bug/feature in Patch
  -> daemon polls items (status=open, type in bug/feature, mapped app, created >= watermark)
  -> claims it (status=in_progress)
  -> ensures a clean checkout of the app's repo under CODE_DIR, resets to origin/<default>
  -> runs headless Claude to TRIAGE (simple vs complex), then act:

     SIMPLE  -> Claude makes the fix -> daemon verifies the build ->
                bumps sw.js, commits, pushes default branch (= Pages deploy) ->
                status=shipped + resolution (commit URL) + "Shipped" phone push

     COMPLEX -> Claude makes NO edits, writes a decision brief ->
                daemon opens a Port session (port_sessions row aimed at the repo,
                seeded with the patch + brief) -> status=needs_info -> "Needs you" push
                -> drive it from the Port app on your phone, decide, and ship it there
```

## Autonomy & safety

The triage gate is the autonomy dial: **simple fixes ship themselves, complex ones go to
your phone.** Claude is told "when in doubt, choose COMPLEX" — a borderline item is handed
to Nate rather than guessed at against the live app. Escalation is unified: anything that
can't ship cleanly unattended (complex, *or* a "simple" fix that then fails to build)
becomes a Port session instead of being silently dropped. Only a clean fix-that-builds
ever reaches the live app. Other guards:

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
# fill SUPABASE_SERVICE_KEY + PORT_PUSH_SECRET (both from ~/port/port-server.env),
# set ENABLED=true when ready
set -a; . ./patch-fixer.env; set +a
nohup node patch-fixer.mjs >> patchfix.log 2>&1 &
```

Watch: `tail -f ~/patchfix/patchfix.log`. Disarm: set `ENABLED=false` and restart, or kill the node process.

## DB

Requires an `items.resolution text` column (see `../schema.sql`) — the daemon writes the
one-line outcome there and the Patch UI shows it under shipped / needs_info cards.
