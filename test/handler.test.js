'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHandler } = require('../index');
const { ScrapeError } = require('../scraper');

const URL = 'https://app.acuityscheduling.com/schedule/rink/appointment/1/calendar/10';
function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    type(value) { this.headers['Content-Type'] = value; return this; },
    send(value) { this.body = value; this.writableEnded = true; return this; },
    json(value) { return this.send(value); },
  });
}
function request(overrides = {}) {
  return { path: '/scrape', method: 'POST', body: { url: URL }, is: type => type === 'application/json', get: () => undefined, ...overrides };
}

test('serves the UI and returns the documented API envelope', async () => {
  const events = [{ eventType: 'stick & puck', eventDate: 'October 18, 2026', eventTime: '7:30 AM - 8:30 AM', spotsLeft: 8 }];
  const handler = createHandler(async (url, days, { signal }) => { assert.equal(url, URL); assert.equal(days, 60); assert.ok(signal instanceof AbortSignal); return events; });
  const ui = response();
  await handler(request({ path: '/', method: 'GET' }), ui);
  assert.match(ui.body, /Acuity scheduling link/);
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { count: 1, events });
});

test('validates routes, methods, content type and body before scraping', async () => {
  const handler = createHandler(() => assert.fail('scraper must not be called'));
  for (const [overrides, status] of [[{ path: '/other' }, 404], [{ method: 'GET' }, 405], [{ is: () => false }, 415], [{ get: () => '5000' }, 413], [{ body: {} }, 400], [{ body: { url: 'https://example.com' } }, 400]]) {
    const res = response();
    await handler(request(overrides), res);
    assert.equal(res.statusCode, status);
    assert.equal(typeof res.body.error, 'string');
  }
});

test('limits concurrent jobs and releases the slot for consecutive runs', async () => {
  let finish;
  let count = 0;
  const handler = createHandler(async () => { count++; if (count === 1) await new Promise(resolve => { finish = resolve; }); return []; });
  const first = response();
  const running = handler(request(), first);
  const second = response();
  await handler(request(), second);
  assert.equal(second.statusCode, 429);
  finish();
  await running;
  const third = response();
  await handler(request(), third);
  assert.equal(third.statusCode, 200);
  assert.deepEqual(third.body, { count: 0, events: [] });
});

test('returns useful upstream errors, cancels disconnected requests and resets after failure', async () => {
  let captured;
  const handler = createHandler(async (_url, _days, { signal }) => { captured = signal; throw new ScrapeError('Upstream changed.', 502); });
  const res = response();
  const pending = handler(request(), res);
  res.emit('close');
  await pending;
  assert.equal(captured.aborted, true);
  assert.equal(res.statusCode, 502);
  const retry = response();
  await handler(request(), retry);
  assert.equal(retry.statusCode, 502);
});
