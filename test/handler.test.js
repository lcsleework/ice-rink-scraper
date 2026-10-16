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

test('GET without a URL scrapes the default Rocket Ice schedule and returns JSON', async () => {
  const handler = createHandler(async (url, days, { signal }) => {
    assert.equal(url, 'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344');
    assert.equal(days, 60);
    assert.equal(signal.aborted, false);
    return [];
  });
  for (const path of ['/', '/scrape', '/scrape/']) {
    const res = response();
    await handler(request({ path, method: 'GET', body: undefined, is: () => false }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { count: 0, events: [] });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('GET query URLs and POST bodies return the same API envelope', async () => {
  const events = [{ eventType: 'stick & puck', eventDate: 'October 18, 2026', eventTime: '7:30 AM - 8:30 AM', spotsLeft: 8 }];
  const handler = createHandler(async (url, days, { signal }) => { assert.equal(url, URL); assert.equal(days, 60); assert.ok(signal instanceof AbortSignal); return events; });
  for (const overrides of [{}, { path: '/', method: 'GET', query: { url: URL }, body: undefined }, { method: 'GET', query: { url: URL }, body: undefined }]) {
    const res = response();
    await handler(request(overrides), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { count: 1, events });
  }
});

test('validates routes, methods, content type and body before scraping', async () => {
  const handler = createHandler(() => assert.fail('scraper must not be called'));
  for (const [overrides, status, allow] of [
    [{ path: '/other' }, 404],
    [{ path: '/', method: 'POST' }, 405, 'GET'],
    [{ method: 'PUT' }, 405, 'GET, POST'],
    [{ path: '/', method: 'HEAD' }, 405, 'GET'],
    [{ method: 'HEAD' }, 405, 'GET, POST'],
    [{ is: () => false }, 415],
    [{ get: () => '5000' }, 413],
    [{ body: {} }, 400],
    [{ body: { url: 'https://example.com' } }, 400],
    [{ method: 'GET', query: { url: 'https://example.com' } }, 400],
    [{ method: 'GET', query: { url: '' } }, 400],
    [{ method: 'GET', query: { url: [URL, URL] } }, 400],
    [{ method: 'GET', query: { url: { nested: URL } } }, 400],
  ]) {
    const res = response();
    await handler(request(overrides), res);
    assert.equal(res.statusCode, status);
    assert.equal(typeof res.body.error, 'string');
    if (allow) assert.equal(res.headers.Allow, allow);
  }
});

test('limits concurrent jobs and releases the slot for consecutive runs', async () => {
  let finish;
  let count = 0;
  const handler = createHandler(async () => { count++; if (count === 1) await new Promise(resolve => { finish = resolve; }); return []; });
  const first = response();
  const running = handler(request({ path: '/', method: 'GET' }), first);
  const second = response();
  await handler(request(), second);
  assert.equal(second.statusCode, 429);
  finish();
  await running;
  const third = response();
  await handler(request({ method: 'GET' }), third);
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
