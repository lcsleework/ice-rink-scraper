'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { getTestServer, getFunction } = require('@google-cloud/functions-framework/testing');
const scraper = require('../scraper');

const URL = 'https://app.acuityscheduling.com/schedule/rink/appointment/1/calendar/10';
const DEFAULT_URL = 'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344';
const events = [{ eventType: 'stick & puck', eventDate: 'October 18, 2026', eventTime: '7:30 AM - 8:30 AM', spotsLeft: 8 }];
// Exercise the actual exported adapters and their query/body parsers without contacting Acuity.
const scrapeMock = mock.method(scraper, 'scrape', async (url, days, { signal }) => {
  assert.ok([URL, DEFAULT_URL].includes(url));
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

for (const target of ['Vercel Express export', 'app', 'getRocketIce_StickPuck2']) {
  test(`${target} returns JSON for GET requests and accepts POST requests over HTTP`, async context => {
    const server = target === 'Vercel Express export' ? http.createServer(vercelApp) : getTestServer(target);
    const base = await listen(server, context);
    assert.equal(getFunction('app'), vercelApp.app);
    for (const [path, url] of [['/', DEFAULT_URL], ['/scrape', DEFAULT_URL], [`/?url=${encodeURIComponent(URL)}`, URL], [`/scrape/?url=${encodeURIComponent(URL)}`, URL]]) {
      const result = await fetch(`${base}${path}`);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type'), /application\/json/);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await result.json(), { count: 1, events });
      assert.equal(scrapeMock.mock.calls.at(-1).arguments[0], url);
    }
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
    const callsBeforeInvalidGets = scrapeMock.mock.callCount();
    for (const query of ['url=', 'url=https%3A%2F%2Fexample.com', `url=${encodeURIComponent(URL)}&url=${encodeURIComponent(URL)}`]) {
      const invalidGet = await fetch(`${base}/?${query}`);
      assert.equal(invalidGet.status, 400);
      assert.equal(typeof (await invalidGet.json()).error, 'string');
    }
    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(head.status, 405);
    assert.equal(head.headers.get('allow'), 'GET');
    assert.equal(scrapeMock.mock.callCount(), callsBeforeInvalidGets);
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
