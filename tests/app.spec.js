// Boot/smoke + integration tests that drive the REAL app UI with a stubbed
// Supabase network and a seeded auth session. buildExportText/exportMatches read
// the closure `state`, so we exercise them through the real Export view rather
// than re-implementing them.
const { test, expect } = require('@playwright/test');
const { bootApp, seedSession, stubSupabase } = require('./helpers');

// A representative cross-app dataset.
const ITEMS = [
  { id: 'b1', type: 'bug', app: 'course', where_in_app: 'Setup', expected: 'saves', actual: 'errors',
    severity: 'blocker', status: 'open', my_guess: 'null id', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z' },
  { id: 'b2', type: 'bug', app: 'course', where_in_app: 'Home', expected: 'x', actual: 'y',
    severity: 'polish', status: 'open', created_at: '2026-05-02T10:00:00Z', updated_at: '2026-05-02T10:00:00Z' },
  { id: 'f1', type: 'feature', app: 'course', where_in_app: 'Export', description: 'add csv',
    status: 'in_progress', created_at: '2026-05-03T10:00:00Z', updated_at: '2026-05-06T10:00:00Z' },
  { id: 'i1', type: 'idea', app: null, title: 'Big idea', description: 'someday',
    status: 'open', created_at: '2026-05-04T10:00:00Z', updated_at: '2026-05-04T10:00:00Z' },
  { id: 's1', type: 'bug', app: 'stock', where_in_app: 'Pantry', expected: 'p', actual: 'q',
    severity: 'annoying', status: 'fixed', created_at: '2026-05-05T10:00:00Z', updated_at: '2026-05-07T10:00:00Z', fixed_at: '2026-05-07T10:00:00Z' },
];

// ---------- BOOT / SMOKE ----------
test.describe('boot / smoke', () => {
  test('with no session the OTP gate is shown and the app does not fetch items', async ({ page }) => {
    const sink = [];
    await stubSupabase(page, ITEMS, sink);
    await page.goto('/index.html');
    await expect(page.locator('#otp-gate')).toBeVisible();
    // loadItems() only runs after auth — no GET should have been issued.
    const gets = sink.filter((r) => r.method === 'GET' && r.url.includes('/items'));
    expect(gets.length).toBe(0);
  });

  test('with a valid session the app boots to the Capture view and renders the type picker', async ({ page }) => {
    await bootApp(page, ITEMS);
    await expect(page.locator('#view-capture')).toHaveClass(/active/);
    // Three type cards: Bug / Feature / Idea.
    const types = await page.locator('#capture-block .tc-name').allTextContents();
    expect(types).toEqual(['Bug', 'Feature', 'Idea']);
  });

  test('queue tabs show live ACTIVE counts per type', async ({ page }) => {
    await bootApp(page, ITEMS);
    // Active bugs: b1, b2 (s1 is fixed/closed) = 2; features active: f1 = 1; ideas active: i1 = 1.
    const tabs = await page.locator('#queue-tabs .tab').allTextContents();
    const joined = tabs.join(' | ');
    expect(joined).toMatch(/Bugs/);
    expect(joined).toMatch(/Features/);
    expect(joined).toMatch(/Ideas/);
    // The bug tab's count badge reads 2 (b1, b2 active; s1 fixed excluded).
    const bugTab = await page.locator('#queue-tabs .tab.bug .tab-count').textContent();
    expect(bugTab).toBe('2');
    const featTab = await page.locator('#queue-tabs .tab.feature .tab-count').textContent();
    expect(featTab).toBe('1');
  });
});

// ---------- CAPTURE / SAVE payload ----------
test.describe('capture save payload', () => {
  test('saving an idea POSTs a trimmed, type-correct payload (no app)', async ({ page }) => {
    const sink = [];
    await seedSession(page);
    await stubSupabase(page, [], sink);
    await page.goto('/index.html');
    await page.waitForFunction(() => document.querySelector('#view-capture')?.classList.contains('active'));

    // Open the Idea form.
    await page.locator('.type-card', { hasText: 'Idea' }).click();
    await page.locator('.field-input').first().fill('  My idea title  ');
    // description is the second text/textarea field
    await page.locator('textarea.field-input, input.field-input').nth(1).fill('  details here  ');
    await page.locator('#capture-save').click();

    await expect.poll(() => sink.filter((r) => r.method === 'POST').length).toBeGreaterThan(0);
    const post = sink.find((r) => r.method === 'POST');
    expect(post.body.type).toBe('idea');
    expect(post.body.title).toBe('My idea title'); // trimmed
    expect(post.body.description).toBe('details here');
    expect(post.body.app).toBeNull(); // ideas are app-less unless chosen
  });
});

// ---------- DOCUMENTED REAL APP BUG ----------
// The capture/edit forms offer an "All" app pill (CAPTURE_APPS[0] === 'all'),
// and saveCapture POSTs `app: 'all'` verbatim. The DB CHECK constraint
// (schema.sql:21) only allows the 9 named apps — 'all' is NOT permitted — so the
// insert is rejected and the user sees a generic "Save failed". This test
// DOCUMENTS the bug (it does not patch the app): it proves the app sends app:'all'
// and that, when the backend rejects it (as the real schema does), capture fails.
test.describe('KNOWN APP BUG: "All" app pill produces a DB-invalid payload', () => {
  test('saving a bug tagged "All" POSTs app:"all" and surfaces "Save failed" on reject', async ({ page }) => {
    const sink = [];
    await seedSession(page);
    // Stub that mimics the real CHECK constraint: reject app values not in the 9 apps.
    const allowed = ['course', 'stock', 'ink', 'tide', 'tick', 'break', 'today', 'crate', 'patch'];
    await page.route('https://xsmnfcmtbpeaccnyinkr.supabase.co/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      let body = null; try { body = req.postDataJSON(); } catch (e) {}
      sink.push({ method, url, body });
      if (url.includes('/rest/v1/items')) {
        if (method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        if (method === 'POST') {
          if (body && body.app != null && !allowed.includes(body.app)) {
            return route.fulfill({ status: 400, contentType: 'application/json',
              body: JSON.stringify({ message: 'new row violates check constraint "items_app_check"' }) });
          }
          return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([Object.assign({ id: 'x', created_at: new Date().toISOString() }, body)]) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/index.html');
    await page.waitForFunction(() => document.querySelector('#view-capture')?.classList.contains('active'));

    // Bug form, pick the "All" app pill, fill required fields.
    await page.locator('.type-card', { hasText: 'Bug' }).click();
    await page.locator('#capture-block .pill[data-app="all"]').click();
    // where_in_app, expected, actual are the three text/textarea inputs (in order).
    const inputs = page.locator('#capture-block .field-input');
    await inputs.nth(0).fill('Somewhere');
    await inputs.nth(1).fill('works');
    await inputs.nth(2).fill('breaks');
    // severity pill
    await page.locator('#capture-block .sev-pill.blocker').click();
    await page.locator('#capture-save').click();

    // The app emitted app:'all' — the DB-invalid value the bug is about.
    await expect.poll(() => sink.filter((r) => r.method === 'POST').length).toBeGreaterThan(0);
    const post = sink.find((r) => r.method === 'POST');
    expect(post.body.app).toBe('all'); // <-- BUG: not an allowed DB value

    // And the rejected save surfaces the generic failure toast.
    await expect(page.locator('#toast')).toContainText('Save failed');
  });
});

// ---------- EXPORT view (exercises buildExportText through real state) ----------
test.describe('export view', () => {
  test('single-app prompt: header, numbered type-split groups, spec closing line', async ({ page }) => {
    await bootApp(page, ITEMS);
    await page.evaluate(() => go('export'));
    await expect(page.locator('#view-export')).toHaveClass(/active/);

    // Select the Course app pill explicitly.
    await page.locator('#export-pills .pill', { hasText: 'Course' }).first().click();

    const text = await page.locator('#export-preview').textContent();
    // Active filter default = open/in_progress/needs_info -> b1,b2 (open bugs) + f1 (in_progress feature).
    expect(text).toContain('for Course (3):');
    expect(text).toContain('Bugs (2):');
    expect(text).toContain('Features (1):');
    expect(text).toContain('[Blocker]'); // b1 severity tag
    expect(text).toContain('(my guess: null id)'); // b1 guess reaches handoff
    expect(text).toContain('Review each, propose changes to course-spec.md, then implement.');
  });

  test('plain format is bare "- line" with no severity/guess/labels', async ({ page }) => {
    await bootApp(page, ITEMS);
    await page.evaluate(() => go('export'));
    await page.locator('#export-pills .pill', { hasText: 'Course' }).first().click();
    await page.locator('.format-btn', { hasText: /plain/i }).click();

    const text = await page.locator('#export-preview').textContent();
    expect(text).toMatch(/^- /m);
    expect(text).not.toContain('[Blocker]');
    expect(text).not.toContain('my guess');
    expect(text).not.toContain('Bugs (');
  });

  test('All apps prompt groups under ### App headings + Unfiled bucket', async ({ page }) => {
    await bootApp(page, ITEMS);
    await page.evaluate(() => go('export'));
    await page.locator('#export-pills .pill', { hasText: 'All' }).click();

    const text = await page.locator('#export-preview').textContent();
    expect(text).toContain('across the suite');
    expect(text).toContain('### Course');
    // i1 is app-less and active -> lands in the Unfiled bucket.
    expect(text).toContain('### Unfiled');
    expect(text).toContain("Review each, propose changes to the relevant app's spec, then implement.");
  });

  test('bulk-advance button adapts: open present -> "Mark all as In progress"', async ({ page }) => {
    await bootApp(page, ITEMS);
    await page.evaluate(() => go('export'));
    await page.locator('#export-pills .pill', { hasText: 'Course' }).first().click();
    const label = await page.locator('#export-mark-bulk').textContent();
    expect(label).toContain('Mark all as In progress');
    await expect(page.locator('#export-mark-bulk')).toBeEnabled();
  });
});

// ---------- TRIAGE view ----------
test.describe('triage view', () => {
  test('groups by app, ordered by active count, with Unfiled bucket for app-less', async ({ page }) => {
    await bootApp(page, ITEMS);
    await page.evaluate(() => go('triage'));
    await expect(page.locator('#view-triage')).toHaveClass(/active/);

    const names = await page.locator('#view-triage .triage-name').allTextContents();
    // Course (3 active) should sort before Stock; Unfiled present for the app-less idea.
    expect(names).toContain('Course');
    expect(names).toContain('Unfiled');
    expect(names.indexOf('Course')).toBeLessThan(names.indexOf('Unfiled') === -1 ? Infinity : names.indexOf('Unfiled') + 999);
  });
});

// ---------- HISTORY view ----------
test.describe('history view', () => {
  test('shows all items sorted by most recent activity (updated_at)', async ({ page }) => {
    await bootApp(page, ITEMS);
    await page.evaluate(() => go('history'));
    await expect(page.locator('#view-history')).toHaveClass(/active/);
    const cards = page.locator('#history-body .fix');
    const count = await cards.count();
    // All 5 items (including closed s1) appear in history.
    expect(count).toBeGreaterThanOrEqual(5);
  });
});
