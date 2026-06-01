// Shared helpers for the Patch QA harness.
// We never re-implement app logic here — we either call the real window globals
// via page.evaluate, or drive the real UI after seeding network + auth.

const SB_HOST = 'https://xsmnfcmtbpeaccnyinkr.supabase.co';
const SB_AUTH_KEY = 'sb-xsmnfcmtbpeaccnyinkr-auth-token';

// Seed a non-expired fake Supabase auth session so hasSession()/authToken() pass
// and startApp() runs. expires_at is unix-seconds, _sessionExpired checks *1000.
async function seedSession(page) {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }));
  }, SB_AUTH_KEY);
}

// Intercept every Supabase REST call. GET /items returns the seeded rows;
// writes echo back a representation so optimistic UI updates resolve.
// Captured requests are recorded so tests can assert what the app sent.
async function stubSupabase(page, items, sink) {
  await page.route(`${SB_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch (e) { body = req.postData(); }
    if (sink) sink.push({ method, url, body });

    // REST data table
    if (url.includes('/rest/v1/items')) {
      if (method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
      }
      if (method === 'POST') {
        const row = Object.assign({
          id: 'new-' + Math.random().toString(16).slice(2),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: 'open',
        }, body || {});
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([row]) });
      }
      // PATCH / DELETE
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([body || {}]) });
    }
    // Auth endpoints (refresh etc.) — should not be hit with a fresh token, but be safe.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

// Boot the app authenticated, with a stubbed network returning `items`.
async function bootApp(page, items = [], sink) {
  await seedSession(page);
  await stubSupabase(page, items, sink);
  await page.goto('/index.html');
  // startApp hides the gate and renders capture; wait for that.
  await page.waitForSelector('#otp-gate', { state: 'hidden' }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#view-capture')?.classList.contains('active'), null, { timeout: 8000 });
}

module.exports = { SB_HOST, SB_AUTH_KEY, seedSession, stubSupabase, bootApp };
