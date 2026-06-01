# Patch — QA Testing Plan

Automated harness for the **Patch** app (single-file vanilla-JS PWA). Tests drive
the app's **real** `window`-global functions via Playwright `page.evaluate`, and
exercise stateful UI flows against the **real** DOM with a stubbed Supabase
network. Nothing is re-implemented.

- Framework: **Playwright** (`@playwright/test`), Chromium.
- Server: `python3 -m http.server 8216 --directory ..` (serves the worktree root
  where `index.html` lives), `reuseExistingServer: true`.
- Run: `cd tests && npx playwright test`.

## How the harness reaches real code

The app's `<script>` is a classic (non-module) script. Top-level
`function foo(){}` declarations become **global** and are called directly:
`displayTitle`, `cardSubline`, `exportLine`, `exportLinePrompt`, `promptGroup`,
`buildExportText`, `formValid`, `sortQueue`, `formatTimestamp`, `summaryText`,
`activeCount`, `newGroup`, `exportMatches`, `go`.

`const`/`let` bindings (`state`, `REQUIRED`, `FORM_FIELDS`, `APPS`, `itemType`,
the label/order maps) are **closure-scoped, not global**. Logic that depends on
them (`buildExportText`, `exportMatches`, the export/triage/history views) is
therefore exercised **through the real UI** after:
1. seeding a non-expired fake Supabase auth session in `localStorage`
   (`sb-...-auth-token`) so `hasSession()` passes and `startApp()` runs, and
2. intercepting every `*.supabase.co` request (Playwright `route`) to return
   seeded `items` rows and echo writes back — so no live network/auth is needed.

See `helpers.js`.

---

## Risk ranking

### NOT covered (gaps — be aware)
- **No live Supabase / RLS / OTP-auth path.** Auth + the network are stubbed.
  Real OTP send/verify (`otpSend`/`otpVerify`), token refresh
  (`_refreshSession`), and the per-user RLS policy are **untested** here.
  (Note: the spec says "open `using(true)` RLS, no per-user auth," but the
  shipped code uses 8-digit email-OTP + a `sb-...-auth-token` session — the
  suite-wide auth migration. The harness matches the *code*, not the spec.)
- **Service worker** (`sw.js`) cache strategy / `CACHE_NAME` bumping — not tested.
- **Clipboard** contents on Copy — we assert `buildExportText` output in the
  preview, not the actual `navigator.clipboard` write (and its `execCommand`
  fallback).
- **Delete + 6s Undo** re-insert (`handleDelete`/`restoreItem`) — not covered.
- **Promote-to-feature** end-to-end (`startPromote` → save parks source idea,
  links `promoted_to`) — not covered (only `cardSubline`'s "Promoted to feature"
  string is unit-tested).
- **Bulk-advance execution** (`itemStatusByIds` PATCH + Undo) — only the adaptive
  button *label/enabled* state is asserted, not the round-trip.
- **Inline edit save diffing** incl. `fixed_at` stamp/clear on status change
  (index.html:1332-1336) — read but not driven by a test.
- **Cross-browser / mobile-viewport** — Chromium desktop only.

### Covered, by risk

| Rank | Area | What & why it's risky | Tests |
|---|---|---|---|
| 1 | **Type classification / headline derivation** (`displayTitle`) | Per-type fallback chains; legacy typeless rows default to `bug` (`itemType`). Wrong fallback = blank/garbage card titles. | `logic.spec.js` displayTitle (4) |
| 2 | **Required-field gating** (`formValid`) | Save button gate; per-type required sets differ (idea needs NO app). A regression silently lets invalid rows through or blocks valid ones. | `logic.spec.js` formValid (3) |
| 3 | **Export prompt framing** (`exportLine`, `exportLinePrompt`, `promptGroup`, `buildExportText`) | The product's whole point — the handoff text. Severity tags, `(my guess:)` append, type-split-only-when->1-type, single-app vs All-apps headings, spec closing line. | `logic.spec.js` exportLine (5) / exportLinePrompt (4) / promptGroup (2); `app.spec.js` export view (4) |
| 4 | **Bug-severity sort** (`sortQueue`) | blocker→annoying→polish→unset, then newest-first; non-bug tabs newest-first; must not mutate input. | `logic.spec.js` sortQueue (3) |
| 5 | **App tagging / capture payload** | `saveCapture` trims + drops empties, sets `app` null for app-less ideas. | `app.spec.js` capture save (1) |
| 6 | **Date helper** (`formatTimestamp`) | Relative-time buckets + calendar fallback >7d. | `logic.spec.js` formatTimestamp (2) |
| 7 | **Triage summary** (`summaryText`, `activeCount`, `newGroup`) | Active-count rollups + closed fallback + "0". | `logic.spec.js` triage summary (3) |
| 8 | **Boot / smoke** | OTP gate when no session (and NO items fetched); authed boot to Capture; live queue-tab counts (active-only). | `app.spec.js` boot/smoke (3) |
| 9 | **Triage / History views** | Per-app grouping + Unfiled bucket; history shows all incl. closed, by `updated_at`. | `app.spec.js` triage (1) / history (1) |
| — | **Documented real bug (does not patch)** | "All" app pill → DB-invalid `app:'all'`. | `app.spec.js` KNOWN APP BUG (1) |

---

## REAL app bugs found (documented, NOT patched)

### BUG 1 — The "All" app pill produces a DB-invalid payload
- **Where:** `index.html:793` (`CAPTURE_APPS = ['all', ...]`) →
  `index.html:1167` (`saveCapture` posts `app: v.app || null`). Same path on
  inline edit via `buildForm` (`index.html:1023`).
- **What:** The capture and inline-edit forms render an **"All"** app pill whose
  value is the string `'all'`. Selecting it and saving POSTs `app: "all"` to
  Supabase. The `items` CHECK constraint (`schema.sql:21`,`:95`) only allows
  `course/stock/ink/tide/tick/break/today/crate/patch` — `'all'` is **not** a
  legal value, so Postgres rejects the row (`items_app_check`) and the user just
  sees the generic **"Save failed"** toast with no explanation.
- **Spec note:** the spec only describes "All" as an **Export selector**
  (`patch-spec.md` §Export), never as a capture/edit *tag*. `CAPTURE_APPS`
  leaking `'all'` into the new-item picker appears unintended.
- **Test:** `app.spec.js` › *KNOWN APP BUG* — proves the app emits `app:'all'`
  and that a constraint-faithful backend rejects it, surfacing "Save failed".
- **Likely fix (for the app owner, not done here):** drop `'all'` from
  `CAPTURE_APPS`, or map the "All" capture choice to `null` before POST.

No other defects found in the covered logic.
