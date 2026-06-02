# Patch — Spec

**Owns:** Structured fix-capture across the suite. Log bugs, features, and ideas on the go; organize by app; hand off Claude-Code-ready prompts.

**Vibe:** Workshop. Fluorescent-lit, clipboard, grease pencil. The app you open the moment you notice something broken — or think of something to build.

**Dialect:** Functional. Card-stack, scannable, fast.

---

## Color Weather

Graphite background + warning-yellow accent (construction-sign yellow, not pastel). Sits tonally adjacent to Tick — utilitarian, night-shift, things-that-need-attention. System-following dark/light; dark is the home state, light is incidental.

Each suite app has an accent used for its pills/tags: course, stock, ink, tide, tick, break, today, crate, cue, patch. The three item types also carry a tint — **bug** = accent yellow, **feature** = tide blue, **idea** = tick lavender.

---

## Core Model

Patch captures three **item types**. Type is chosen first, before anything else, because it determines which fields you fill.

- **Bug** — "something is broken." Where it lives, what you expected, what actually happened, how bad it is.
- **Feature** — "something to build." Where it lives and a description.
- **Idea** — "a thought to weigh." A title and a description. Not tied to an app by default. Can later be **promoted to a feature**.

Type is a *handoff category*, not a priority scale. All three types are exported and handed to Claude Code together; the only difference is how the export prompt frames them.

### Fields per type

Required fields are marked •. Everything else is optional.

| Field | Bug | Feature | Idea |
|---|---|---|---|
| `app` | • | • | optional |
| `where_in_app` | • | • | — |
| `expected` | • | — | — |
| `actual` | • | — | — |
| `severity` (blocker / annoying / polish) | • | — | — |
| `description` | — | • | • |
| `title` | — | — | • |
| `my_guess` | optional | optional | — |
| `device_context` | optional | — | — |
| `image_url` | optional | optional | — |

Per-type requiredness is enforced **in the app** (the Save button stays disabled until required fields are filled), not by the database — every column except `type`/`status`/timestamps is nullable so the schema doesn't fight type changes.

### Statuses

A six-state lifecycle: `open` → `in_progress` → `fixed` / `shipped`, with `needs_info` and `parked` as side states.

- **Active** = `open`, `in_progress`, `needs_info` — these are what the home queue and triage show by default.
- **Closed** = `fixed`, `shipped`, `parked`.
- `fixed` / `shipped` stamp `fixed_at`; moving back out clears it.

---

## Core Screens

Four views, switched via the top-right utility links (no modals): **Capture** (home), **Triage**, **History**, **Export**.

### 1. Capture (Home)

The whole point of the app.

**Describe it (freeform)** — above the type picker, one button opens a single textarea: dump the thing in plain words, by typing or by **voice** (a mic button uses the Web Speech API where available; the textarea also accepts the OS keyboard's own dictation everywhere). **Format →** sends the text through the suite's shared `claude` edge proxy (JWT-gated, Anthropic key server-side — no client API key) which classifies the **type**, picks the **app**, and fills the type's fields, returning JSON. The result lands in the normal capture form as an **editable preview** (banner: "Drafted from your description — review and edit, then save"), with **Back to text** to re-edit the source. Save is the same path as a manual capture; required fields Claude couldn't infer keep Save disabled until filled. Friction-light path for capturing on the go.

**Type picker** — three large cards: Bug / Feature / Idea, each with a one-line description. Tap one to open its form. ("Change type" returns to the picker.)

**Per-type form** — only the fields for that type, required fields dotted, text input autofocused. `app` is a row of color-coded pills; the **last-used app is pre-selected** (persisted in `localStorage` as `patch_last_app`); ideas start app-less. Severity is a three-pill row (Blocker / Annoying / Polish). Save is enter-to-save via **Cmd/Ctrl+Enter**, or the button. No toast on save — the item appearing in the queue is the feedback.

**Queue tabs** — Bugs / Features / Ideas, each with a live count of its **active** items. Bugs sort by severity (blocker → annoying → polish → unset) then newest-first; features and ideas sort newest-first. Empty states are per-tab ("Nothing to fix." / "No features yet." / "No ideas yet.").

**Item card** shows: app tag, a type tag (feature/idea; bugs are unmarked so the list reads as "things broken"), a severity chip for bugs, the headline (`displayTitle`), a subline (`where_in_app`, or "Promoted to feature" on a parked idea), a status chip, and a relative timestamp. Tap a card → inline edit.

**Inline edit** lets you change type (a pill row), edit every field of the current type, and set status (a pill row of all six). Changing an item's type leaves the old type's fields in the row untouched rather than dropping data. Delete is available here, with a 6-second **Undo** toast (re-inserts the full row). Idea cards also get **Promote to feature** — opens a pre-filled feature form; on save the source idea is parked and linked via `promoted_to`.

### 2. Triage

Same data, regrouped by app. One collapsible section per app (plus an **Unfiled** bucket for app-less items), ordered by active-count descending. Section header shows a summary ("3 open · 1 in progress"). Status **filter chips** at top default to the active set (open / in_progress / needs_info); toggle any on to include closed items. Cards are the same as home and open the same inline editor.

**Purpose:** pre-flight before a Claude Code session — "what's queued for Course?" in one glance.

### 3. History

All items, most-recent-activity-first (by `updated_at`), capped at 100. The audit trail — including closed items — without the per-app grouping of triage. Cards open the same inline editor; timestamps show last activity.

### 4. Export / Handoff

Generates the prompt you paste into Claude Code.

**Controls:** app selector (pills, single-select, includes **All**), status filter chips (multi-select, default active set), and a format toggle. A live **preview** renders below; **Copy** writes to the clipboard with a toast ("Copied — N items").

**Bulk advance:** an adaptive button — "Mark all as In progress" when open items match, then "Mark all as Fixed" when in-progress ones do — with an Undo toast. It advances the matching items for the selected app by status.

**Two formats:**

- **Claude Code prompt** — numbered, and split into `Bugs (M):` / `Features (K):` / `Ideas (J):` groups only when more than one type is present (single-type stays a flat list). Bug lines lead with a `[Severity]` tag; bug and feature lines append `(my guess: …)` when a guess was captured — so the context you typed reaches the handoff. For a single app it closes with "Review each, propose changes to `{app}-spec.md`, then implement." For **All**, items are grouped under `### App (N)` headings (with an Unfiled bucket) and the closing line is generic.
- **Plain list** — bare `- item` lines, no severity, no guess, no labels. Deliberately context-free; the paste-anywhere format.

---

## Schema

Single Supabase table, `items`, on the shared suite project (`xsmnfcmtbpeaccnyinkr`). See `schema.sql` for the canonical DDL + the `patches` → `items` migration.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | pk, `gen_random_uuid()` |
| `type` | text | `bug` / `feature` / `idea` (default `idea`), not null |
| `app` | text | one of the ten suite apps, or null (ideas) |
| `title` | text | ideas; backfilled on legacy rows |
| `where_in_app` | text | bug + feature |
| `expected`, `actual` | text | bug only |
| `description` | text | feature + idea |
| `severity` | text | `blocker` / `annoying` / `polish`, bug only |
| `status` | text | six-state lifecycle (above), default `open`, not null |
| `my_guess` | text | optional hunch at the cause (bug + feature) |
| `device_context` | text | optional (bug) |
| `image_url` | text | optional screenshot link |
| `repo` | text | optional repo override — **reserved, not yet wired** |
| `promoted_to` | uuid | set on a parked idea when promoted to a feature |
| `created_at`, `updated_at` | timestamptz | `updated_at` via trigger |
| `fixed_at` | timestamptz | set on fixed/shipped |

The legacy single-text column `text` is retained nullable for back-compat (droppable once the backfill is confirmed). Apps: `course / stock / ink / tide / tick / break / today / crate / cue / patch`.

---

## What Patch Doesn't Do

Non-goals — list here so feature creep gets caught:

- **No screenshots / image upload.** There's an optional `image_url` text field for a link, but no attachment flow. Capture friction kills inbox apps.
- **No spec rewriting in-app.** Patch generates a prompt; Claude Code does the spec update. Patch is dumb on purpose.
- **No GitHub integration.** No commits, PRs, or branch writes. You run CC manually with the copied prompt.
- **No priority field beyond bug severity.** Severity sorts the bug queue; it is not a P1/P2/P3 system across types.
- **No assignee / collaboration.** Single-user.
- **No cross-app reads.** Patch knows nothing about Tick/Course/etc.; it only collects fixes about them.

---

## Cross-App Integration

**Patch → all apps:** one-way capture. Patch reads no other app's data; it collects fixes and exports Claude-Code-ready prompts.

**Patch ← nothing:** no app writes to Patch. The friction of switching apps to log a fix is the signal that the fix mattered.

---

## Stack & Auth

- Single-file PWA (`index.html`), no build step, GitHub Pages (repo `Patch-App`).
- Supabase REST against `items`, using the suite **anon key** with an open `using(true)` RLS policy — no per-user auth (single-user app; matches the rest of the suite).
- Service worker (`sw.js`): network-first for Supabase (data always fresh), cache-first for static assets. **Bump `CACHE_NAME` on every `index.html` change** so installed clients update.
- Installable; mobile-first ~440px column, centered on desktop; system-following dark/light.

---

*Last updated: May 2026 — rewritten to match the typed-items app (bug/feature/idea, six-state lifecycle, Capture/Triage/History/Export views, promote-to-feature, severity + my_guess in the export prompt). Supersedes the original flat bug-tracker spec.*
