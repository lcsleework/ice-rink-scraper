'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { getTestServer, getFunction } = require('@google-cloud/functions-framework/testing');
const scraper = require('../scraper');

const URL = 'https://app.acuityscheduling.com/schedule/rink/appointment/1/calendar/10';
const events = [{ eventType: 'stick & puck', eventDate: 'October 18, 2026', eventTime: '7:30 AM - 8:30 AM', spotsLeft: 8 }];
// Exercise the actual exported adapters and their JSON parsers without contacting Acuity.
mock.method(scraper, 'scrape', async (url, days, { signal }) => {
  assert.equal(url, URL);
  assert.equal(days, 60);
  assert.equal(signal.aborted, false);
  return events;
});
const vercelApp = require('../index');

async function listen(server, context) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const target of ['Vercel Express export', 'Google Functions Framework']) {
  test(`${target} serves the UI and accepts JSON scrape requests over HTTP`, async context => {
    const server = target === 'Vercel Express export' ? http.createServer(vercelApp) : getTestServer('app');
    const base = await listen(server, context);
    assert.equal(getFunction('app'), vercelApp.app);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Acuity scheduling link/);
    const result = await fetch(`${base}/scrape`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: URL }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { count: 1, events });
    const invalid = await fetch(`${base}/scrape`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Only app.acuityscheduling/);
  });
}

test('Vercel returns JSON errors for malformed and oversized request bodies', async context => {
  const base = await listen(http.createServer(vercelApp), context);
  for (const [body, code, message] of [
    ['{"url":', 400, /valid JSON/],
    [JSON.stringify({ url: URL, padding: 'x'.repeat(5000) }), 413, /too large/],
  ]) {
    const result = await fetch(`${base}/scrape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(result.status, code);
    assert.match((await result.json()).error, message);
  }
});
