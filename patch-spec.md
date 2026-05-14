# Patch — Spec

**Owns:** Fix capture across the suite. Log fixes on the go, organize by app, hand off to Claude Code for execution.

**Vibe:** Workshop. Fluorescent-lit, clipboard, grease pencil. The app you open the moment you notice something broken.

**Dialect:** Functional. Card-stack, scannable, fast.

---

## Color Weather

Graphite background + warning-yellow accent (think construction sign yellow, not pastel). Sits tonally adjacent to Tick — utilitarian, night-shift, things-that-need-attention. Status chips use small color variations (open = yellow, doing = blue, done = muted green, won't = struck-through gray).

System-following dark/light. Dark is the home state; light mode is incidental.

---

## Core Screens

### 1. Capture (Home)

The whole point of the app. Optimized for 4-second logging.

**Top of screen:**
- "Patch" title, bold, left-aligned (suite convention)
- Utility links top-right: triage view toggle, export

**The capture block (the hero):**
- Six app pills in a single row: Tick / Break / Tide / Still / Course / Patch
  - Each pill colored with that app's accent
  - Tap to select; selected pill stays highlighted
  - Last-used pill is pre-selected on app open
- Below pills: big text input, autofocused on app open, placeholder "What's broken?"
- Single "Save" button below (or enter-to-save on desktop)

No modal. No "add fix" button. The capture surface IS the home screen.

**Below the capture block:**
- The inbox itself, reverse-chronological
- Each fix as a card showing:
  - App pill (color-coded, small)
  - Fix text (primary, bold-ish)
  - Status chip (small, right side)
  - Timestamp (muted, bottom of card)
- Tap card → inline edit + status change
- Long-press or swipe → delete

**Empty state:** "Nothing to fix."

---

### 2. Triage View

Same data, regrouped. Toggle via top-right utility link.

- Six collapsible sections, one per app, ordered by open-count descending
- Section header: app name + open count ("Course · 5 open")
- Each section shows its fixes as cards (same card structure as home)
- Done and Won't fixes hidden by default; show via filter chip at top ("Showing: Open, Doing")

**Purpose:** Pre-flight check before a Claude Code session. "What's queued up for Course?" answered in one glance.

---

### 3. Export / Handoff

Modal or dedicated screen, accessed from utility link.

**Controls:**
- App selector (pills, single-select)
- Status filter chips (multi-select, default: Open + Doing)
- Preview panel showing the formatted output below

**Two output formats:**

**Copy as Claude Code prompt:**
```
Open fixes for [App] (N):
1. [Fix text]
2. [Fix text]
...

Review each, propose changes to [app]-spec.md, then implement.
```

**Copy as plain list:**
```
- [Fix text]
- [Fix text]
...
```

Single "Copy" button. Toast confirms ("Copied — 5 fixes").

After copy: optional "Mark all as Doing" button (so the next time you open Patch, you can see what's mid-flight).

---

## Schema

Single Supabase table on the existing shared project.

**`patches`**

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | primary key, default gen_random_uuid() |
| `app` | text | enum check: tick / break / tide / still / course / patch |
| `text` | text | the fix itself, not null |
| `status` | text | enum check: open / doing / done / wont, default 'open' |
| `created_at` | timestamptz | default now() |
| `updated_at` | timestamptz | default now(), updated via trigger |

No image field. No severity. No screen/area. If a field starts feeling necessary, add it after two weeks of real use, not before.

---

## Microcopy

Terse, suite-consistent.

- Empty inbox: "Nothing to fix."
- After save: no toast — just the fix appearing in the list is feedback enough
- Triage section header: "Course · 5 open"
- Export preview: "Copied — 5 fixes"
- Confirm delete: "Delete this fix?" / "Delete"
- Status chips: Open, Doing, Done, Won't (capitalized, no extra words)

---

## What Patch Doesn't Do

Explicit non-goals — list here so future feature creep gets caught:

- **No screenshots / image attachments.** Capture friction kills inbox apps. If a visual bug is hard to describe in words, save the screenshot to camera roll and reference it in the fix text ("see screenshot, May 14 ~9pm").
- **No spec rewriting in-app.** Patch generates a Claude Code prompt; CC does the spec update. Patch is dumb on purpose.
- **No GitHub integration.** No commits, no PRs, no branch writes. Patch hands off a prompt; you run CC manually.
- **No priority / severity field.** App + status is enough signal. "I'll do the Course ones tonight" beats a P1/P2/P3 system you'll stop maintaining.
- **No assignee / collaborator features.** Single-user app.
- **No cross-app reads.** Patch doesn't know what's in Tick or Still. It only collects fixes about them.

---

## Cross-App Integration

**Patch → all apps:** One-way capture. Patch reads no other app's data; it just collects fixes about them and exports Claude-Code-ready prompts.

**Patch ← nothing:** No app writes to Patch. If you notice a fix while using another app, you open Patch and log it. Manual on purpose — the friction of switching apps is the signal that the fix mattered enough to capture.

---

## External Integrations

None. Patch is self-contained.

(No Claude API calls. No Notion. No Oura. The handoff is the user copying a prompt and pasting it into Claude Code.)

---

## Stack

Same as the rest of the suite:
- Single-file PWA (`index.html`) on GitHub Pages
- Supabase REST for the `patches` table
- No build step, no server-side code
- Own GitHub repo + GitHub Pages URL
- Installable to home screen
- System-following dark/light
- Mobile-first ~440px column, centered on desktop

---

## Suite Doc Updates

Two additions to `suite-context-Nate-Apps.md` when this ships:

**The Suite table:**

| App | Owns | Color Weather |
|---|---|---|
| **Patch** | Fix capture — log fixes across the suite, hand off to Claude Code | Graphite bg + warning-yellow accent. Workshop, clipboard, single bulb. |

**Cross-App Integration section:**

> **Patch → all apps** — One-way capture. Patch reads no other app's data; it just collects fixes and exports Claude Code prompts.

---

## Build Order

1. Schema + Supabase table + RLS policy (single-user, your auth)
2. Capture screen (home) — input, pills, list, status chips, edit/delete
3. Triage view — grouping, collapse, filter
4. Export modal — pill selector, status filter, prompt template, copy
5. HTML mockups committed before any CC implementation work
6. Polish: empty states, last-used pill memory, mark-all-as-doing after export

---

*Last updated: May 2026.*
