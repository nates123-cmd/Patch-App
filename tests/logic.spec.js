// Pure-logic tests: call the REAL window-global helpers directly.
// These cover Patch's riskiest non-UI logic — type-aware headline derivation,
// required-field gating, bug-severity sort, and export line framing.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html'); // gate shows; globals are defined regardless of auth.
});

// ---- displayTitle: type-aware headline derivation ----
test.describe('displayTitle', () => {
  test('prefers explicit title (trimmed) for any type', async ({ page }) => {
    const r = await page.evaluate(() => [
      displayTitle({ type: 'idea', title: '  Hello  ', description: 'x' }),
      displayTitle({ type: 'bug', title: 'T', expected: 'e' }),
    ]);
    expect(r).toEqual(['Hello', 'T']);
  });

  test('bug falls back expected -> where_in_app -> actual -> (bug)', async ({ page }) => {
    const r = await page.evaluate(() => [
      displayTitle({ type: 'bug', expected: 'E', where_in_app: 'W', actual: 'A' }),
      displayTitle({ type: 'bug', where_in_app: 'W', actual: 'A' }),
      displayTitle({ type: 'bug', actual: 'A' }),
      displayTitle({ type: 'bug' }),
    ]);
    expect(r).toEqual(['E', 'W', 'A', '(bug)']);
  });

  test('feature falls back description -> where_in_app -> (feature)', async ({ page }) => {
    const r = await page.evaluate(() => [
      displayTitle({ type: 'feature', description: 'D', where_in_app: 'W' }),
      displayTitle({ type: 'feature', where_in_app: 'W' }),
      displayTitle({ type: 'feature' }),
    ]);
    expect(r).toEqual(['D', 'W', '(feature)']);
  });

  test('idea falls back description -> (idea); missing type defaults to bug path', async ({ page }) => {
    const r = await page.evaluate(() => [
      displayTitle({ type: 'idea', description: 'D' }),
      displayTitle({ type: 'idea' }),
      // itemType() defaults a typeless row to 'bug'
      displayTitle({ expected: 'legacyE' }),
    ]);
    expect(r).toEqual(['D', '(idea)', 'legacyE']);
  });
});

// ---- cardSubline ----
test('cardSubline: where_in_app for bug/feature, promoted note for parked idea', async ({ page }) => {
  const r = await page.evaluate(() => [
    cardSubline({ type: 'bug', where_in_app: 'Settings' }),
    cardSubline({ type: 'feature', where_in_app: 'Home' }),
    cardSubline({ type: 'feature' }),
    cardSubline({ type: 'idea', promoted_to: 'abc' }),
    cardSubline({ type: 'idea' }),
  ]);
  expect(r).toEqual(['Settings', 'Home', '', 'Promoted to feature', '']);
});

// ---- formValid: per-type required-field gating (Save button gate) ----
test.describe('formValid', () => {
  test('bug requires app, where_in_app, expected, actual, severity', async ({ page }) => {
    const full = { app: 'ink', where_in_app: 'w', expected: 'e', actual: 'a', severity: 'polish' };
    const r = await page.evaluate((f) => ({
      full: formValid('bug', f),
      noSeverity: formValid('bug', Object.assign({}, f, { severity: null })),
      blankExpected: formValid('bug', Object.assign({}, f, { expected: '   ' })),
      noApp: formValid('bug', Object.assign({}, f, { app: undefined })),
    }), full);
    expect(r).toEqual({ full: true, noSeverity: false, blankExpected: false, noApp: false });
  });

  test('feature requires app, where_in_app, description (not severity)', async ({ page }) => {
    const r = await page.evaluate(() => ({
      full: formValid('feature', { app: 'course', where_in_app: 'w', description: 'd' }),
      missingDesc: formValid('feature', { app: 'course', where_in_app: 'w' }),
    }));
    expect(r).toEqual({ full: true, missingDesc: false });
  });

  test('idea requires title + description but NOT app (app-less by default)', async ({ page }) => {
    const r = await page.evaluate(() => ({
      noApp: formValid('idea', { title: 't', description: 'd' }),
      missingTitle: formValid('idea', { description: 'd' }),
    }));
    expect(r).toEqual({ noApp: true, missingTitle: false });
  });
});

// ---- sortQueue: bug severity ordering, others newest-first ----
test.describe('sortQueue', () => {
  test('bugs sort blocker -> annoying -> polish -> unset, then newest-first', async ({ page }) => {
    const order = await page.evaluate(() => {
      const mk = (id, sev, t) => ({ id, severity: sev, created_at: t });
      const items = [
        mk('polish', 'polish', '2026-01-05'),
        mk('unset', null, '2026-01-10'),
        mk('blockerOld', 'blocker', '2026-01-01'),
        mk('blockerNew', 'blocker', '2026-01-09'),
        mk('annoying', 'annoying', '2026-01-02'),
      ];
      return sortQueue(items, 'bug').map((x) => x.id);
    });
    expect(order).toEqual(['blockerNew', 'blockerOld', 'annoying', 'polish', 'unset']);
  });

  test('features/ideas ignore severity, sort newest-first', async ({ page }) => {
    const order = await page.evaluate(() => {
      const items = [
        { id: 'a', created_at: '2026-01-01' },
        { id: 'c', created_at: '2026-01-03' },
        { id: 'b', created_at: '2026-01-02' },
      ];
      return sortQueue(items, 'feature').map((x) => x.id);
    });
    expect(order).toEqual(['c', 'b', 'a']);
  });

  test('does not mutate the input array', async ({ page }) => {
    const same = await page.evaluate(() => {
      const items = [{ id: 'x', created_at: '2026-01-01' }, { id: 'y', created_at: '2026-01-02' }];
      const before = items.map((i) => i.id).join();
      sortQueue(items, 'bug');
      return before === items.map((i) => i.id).join();
    });
    expect(same).toBe(true);
  });
});

// ---- exportLine: deliberately context-free plain line ----
test.describe('exportLine (plain format line)', () => {
  test('bug renders "where: expected X — got Y"', async ({ page }) => {
    const r = await page.evaluate(() => exportLine({
      type: 'bug', where_in_app: 'Login', expected: 'redirect', actual: 'blank screen',
    }));
    expect(r).toBe('Login: expected redirect — got blank screen');
  });

  test('bug with no where_in_app omits the prefix; missing exp/act use "?"', async ({ page }) => {
    const r = await page.evaluate(() => [
      exportLine({ type: 'bug', expected: 'E' }),
      exportLine({ type: 'bug', actual: 'A' }),
    ]);
    expect(r).toEqual(['expected E — got ?', 'expected ? — got A']);
  });

  test('bug with neither expected nor actual falls back to displayTitle', async ({ page }) => {
    const r = await page.evaluate(() => exportLine({ type: 'bug', where_in_app: 'X' }));
    expect(r).toBe('X');
  });

  test('feature prefixes where_in_app to description', async ({ page }) => {
    const r = await page.evaluate(() => [
      exportLine({ type: 'feature', where_in_app: 'Home', description: 'dark mode' }),
      exportLine({ type: 'feature', description: 'no where' }),
    ]);
    expect(r).toEqual(['Home: dark mode', 'no where']);
  });

  test('idea joins title — description', async ({ page }) => {
    const r = await page.evaluate(() => [
      exportLine({ type: 'idea', title: 'T', description: 'D' }),
      exportLine({ type: 'idea', title: 'T only' }),
      exportLine({ type: 'idea', description: 'D only' }),
    ]);
    expect(r).toEqual(['T — D', 'T only', 'D only']);
  });
});

// ---- exportLinePrompt: severity tag + my_guess append ----
test.describe('exportLinePrompt (Claude Code prompt line)', () => {
  test('bug leads with [Severity] and appends (my guess: ...)', async ({ page }) => {
    const r = await page.evaluate(() => exportLinePrompt({
      type: 'bug', severity: 'blocker', where_in_app: 'X', expected: 'a', actual: 'b',
      my_guess: '  race condition  ',
    }));
    expect(r).toBe('[Blocker] X: expected a — got b (my guess: race condition)');
  });

  test('feature appends guess but no severity tag', async ({ page }) => {
    const r = await page.evaluate(() => exportLinePrompt({
      type: 'feature', where_in_app: 'Y', description: 'thing', my_guess: 'easy',
    }));
    expect(r).toBe('Y: thing (my guess: easy)');
  });

  test('idea has neither severity tag nor guess', async ({ page }) => {
    const r = await page.evaluate(() => exportLinePrompt({
      type: 'idea', title: 'T', description: 'D', my_guess: 'ignored-for-idea',
    }));
    expect(r).toBe('T — D');
  });

  test('blank/whitespace my_guess produces no suffix', async ({ page }) => {
    const r = await page.evaluate(() => exportLinePrompt({
      type: 'feature', where_in_app: 'Y', description: 'z', my_guess: '   ',
    }));
    expect(r).toBe('Y: z');
  });
});

// ---- promptGroup: type-split only when >1 type present ----
test.describe('promptGroup', () => {
  test('single type stays a flat numbered list (no headers)', async ({ page }) => {
    const out = await page.evaluate(() => promptGroup([
      { type: 'feature', where_in_app: 'A', description: 'one' },
      { type: 'feature', where_in_app: 'B', description: 'two' },
    ]));
    expect(out).toBe('1. A: one\n2. B: two');
  });

  test('multiple types split into Bugs/Features/Ideas blocks with per-group numbering', async ({ page }) => {
    const out = await page.evaluate(() => promptGroup([
      { type: 'bug', severity: 'polish', where_in_app: 'A', expected: 'x', actual: 'y' },
      { type: 'feature', where_in_app: 'B', description: 'feat' },
      { type: 'idea', title: 'I', description: 'd' },
    ]));
    expect(out).toBe(
      'Bugs (1):\n1. [Polish] A: expected x — got y\n\n' +
      'Features (1):\n1. B: feat\n\n' +
      'Ideas (1):\n1. I — d'
    );
  });
});

// ---- formatTimestamp: relative date helper ----
test.describe('formatTimestamp', () => {
  test('buckets recent times correctly', async ({ page }) => {
    const r = await page.evaluate(() => {
      const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
      return {
        now: formatTimestamp(ago(10)),
        mins: formatTimestamp(ago(60 * 5)),
        hours: formatTimestamp(ago(3600 * 3)),
        yesterday: formatTimestamp(ago(86400 * 1.2)),
        days: formatTimestamp(ago(86400 * 4)),
      };
    });
    expect(r.now).toBe('just now');
    expect(r.mins).toBe('5m ago');
    expect(r.hours).toBe('3h ago');
    expect(r.yesterday).toBe('Yesterday');
    expect(r.days).toBe('4d ago');
  });

  test('older than a week falls back to a calendar date (not relative)', async ({ page }) => {
    const r = await page.evaluate(() => formatTimestamp('2020-03-15T12:00:00Z'));
    expect(r).not.toMatch(/ago|just now|Yesterday/);
    expect(r).toMatch(/Mar/);
  });
});

// ---- summaryText / activeCount / newGroup: triage section header ----
test.describe('triage summary', () => {
  test('summaryText lists active counts joined by middot', async ({ page }) => {
    const r = await page.evaluate(() => {
      const g = newGroup();
      g.counts = { open: 3, in_progress: 1 };
      g.total = 4;
      return summaryText(g);
    });
    expect(r).toBe('3 open · 1 in progress');
  });

  test('summaryText shows closed count when no active items', async ({ page }) => {
    const r = await page.evaluate(() => {
      const g = newGroup();
      g.counts = { fixed: 2, shipped: 1 };
      g.total = 3;
      return summaryText(g);
    });
    expect(r).toBe('3 closed');
  });

  test('summaryText is "0" for an empty group; activeCount sums active only', async ({ page }) => {
    const r = await page.evaluate(() => {
      const empty = newGroup();
      const g = newGroup();
      g.counts = { open: 2, needs_info: 1, fixed: 5 };
      return { emptySummary: summaryText(empty), active: activeCount(g) };
    });
    expect(r).toEqual({ emptySummary: '0', active: 3 });
  });
});
