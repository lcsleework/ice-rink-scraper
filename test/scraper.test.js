'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScraper } = require('../scraper');

const URL = 'https://app.acuityscheduling.com/schedule/rink/appointment/1/calendar/10';
const NOW = new Date('2026-10-07T18:00:00Z');
const business = {
  ownerKey: 'rink', timezone: 'America/Chicago',
  calendars: { '': [{ id: 10, timezone: 'America/Chicago' }, { id: 20, timezone: 'America/Chicago' }] },
  appointmentTypes: { '': [
    { id: 1, name: 'Stick & Puck', active: true, type: 'class', duration: 60, calendarIDs: [10] },
    { id: 2, name: 'Freestyle', active: true, type: 'class', duration: 30, calendarIDs: [20] },
    { id: 3, name: 'Hidden', active: true, private: true, type: 'class', duration: 60, calendarIDs: [20] },
  ] },
};

function fixture({ metadata = business, available = [], slots = {}, intercept, now = NOW, timeoutMs, sleep } = {}) {
  const calls = [];
  const scrape = createScraper({
    now: () => now, timeoutMs, sleep,
    fetchImpl: async (address, options) => {
      const url = new globalThis.URL(address);
      calls.push(url);
      const intercepted = await intercept?.(url, options, calls.length);
      if (intercepted) return intercepted;
      if (url.pathname.startsWith('/schedule/')) return new Response(`<script>var BUSINESS = ${JSON.stringify(metadata, null, 2)};</script>`);
      if (url.pathname.endsWith('/month')) {
        const month = url.searchParams.get('month');
        return Response.json(Object.fromEntries([[month, false], ...available.filter(date => date.startsWith(month.slice(0, 7))).map(date => [date, true])]));
      }
      const date = url.searchParams.get('startDate');
      return Response.json({ [date]: slots[date] || [] });
    },
  });
  return { scrape, calls };
}

test('exports sorted, deduplicated records with duration and spaces; includes day 60 only', async () => {
  const { scrape, calls } = fixture({
    available: ['2026-10-07', '2026-10-18', '2026-12-06', '2026-12-07'],
    slots: {
      '2026-10-07': [{ time: '2026-10-07T12:00:00-0500', slotsAvailable: 2 }],
      '2026-10-18': [
        { time: '2026-10-18T08:40:00-0500', slotsAvailable: 10 },
        { time: '2026-10-18T07:30:00-0500', slotsAvailable: 8 },
        { time: '2026-10-18T07:30:00-0500', slotsAvailable: 8 },
        { time: '2026-10-18T23:30:00-0500', slotsAvailable: 0 },
      ],
      '2026-12-06': [{ time: '2026-12-06T23:59:00-0600' }],
    },
  });
  const result = await scrape(URL);
  assert.deepEqual(result[0], { eventType: 'stick & puck', eventDate: 'October 18, 2026', eventTime: '7:30 AM - 8:30 AM', spotsLeft: 8 });
  assert.equal(result.length, 4);
  assert.equal(result[1].eventTime, '8:40 AM - 9:40 AM');
  assert.equal(result[2].eventTime, '11:30 PM - 12:30 AM');
  assert.equal(result[2].spotsLeft, 0);
  assert.equal(result[3].eventDate, 'December 6, 2026');
  assert.equal(result[3].spotsLeft, null);
  assert.equal(calls.some(url => url.searchParams.get('startDate') === '2026-12-07'), false);
  assert.deepEqual(calls.filter(url => url.pathname.endsWith('/month')).map(url => url.searchParams.get('month')), ['2026-10-01', '2026-11-01', '2026-12-01']);
  assert.ok(calls.slice(1).every(url => url.searchParams.get('appointmentTypeId') === '1' && url.searchParams.get('calendarId') === '10'));
});

test('starts on the rink date even when UTC is tomorrow, and crosses year boundaries', async () => {
  const { scrape, calls } = fixture({ now: new Date('2027-01-01T01:00:00Z'), available: ['2026-12-31'], slots: { '2026-12-31': [{ time: '2026-12-31T20:00:00-0600', slotsAvailable: 1 }] } });
  const result = await scrape(URL, 1);
  assert.equal(result[0].eventDate, 'December 31, 2026');
  assert.deepEqual(calls.filter(url => url.pathname.endsWith('/month')).map(url => url.searchParams.get('month')), ['2026-12-01', '2027-01-01']);
});

test('uses timestamp offsets across the daylight-saving transition', async () => {
  const { scrape } = fixture({ now: new Date('2026-11-01T00:00:00Z'), available: ['2026-11-01'], slots: { '2026-11-01': [{ time: '2026-11-01T01:30:00-0500', slotsAvailable: 4 }, { time: '2026-11-01T01:30:00-0600', slotsAvailable: 5 }] } });
  const result = await scrape(URL, 1);
  assert.equal(result[0].eventTime, '1:30 AM - 1:30 AM');
  assert.equal(result[1].eventTime, '1:30 AM - 2:30 AM');
  assert.equal(result.length, 2);
});

test('keeps checking later months after an unpublished month', async () => {
  const { scrape } = fixture({ available: ['2026-12-01'], slots: { '2026-12-01': [{ time: '2026-12-01T09:00:00-0600', slotsAvailable: 10 }] } });
  assert.equal((await scrape(URL)).length, 1);
  assert.deepEqual(await fixture().scrape(URL), []);
});

test('general links include visible types, while explicit links select only that type', async () => {
  const { scrape, calls } = fixture();
  await scrape('https://app.acuityscheduling.com/schedule/rink', 1);
  assert.deepEqual([...new Set(calls.slice(1).map(url => url.searchParams.get('appointmentTypeId')))], ['1', '2']);
  await assert.rejects(scrape('https://app.acuityscheduling.com/schedule/rink/appointment/99'), /No appointments match/);
});

test('uses null when the business hides remaining spaces', async () => {
  const { scrape } = fixture({ metadata: { ...business, hideSpotsClasses: true }, available: ['2026-10-18'], slots: { '2026-10-18': [{ time: '2026-10-18T09:00:00-0500', slotsAvailable: 10 }] } });
  assert.equal((await scrape(URL))[0].spotsLeft, null);
});

test('does not evaluate scripts in upstream HTML', async () => {
  const { scrape } = fixture({ intercept: url => url.pathname.startsWith('/schedule/') ? new Response('<script>var BUSINESS = (() => { throw new Error("executed"); })();</script>') : null });
  await assert.rejects(scrape(URL), /supported Acuity scheduler/);
});

test('validates every redirect before following it', async () => {
  const { scrape, calls } = fixture({ intercept: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/computeMetadata/v1/' } }) });
  await assert.rejects(scrape('https://rink.as.me/'), /redirects outside/);
  assert.equal(calls.length, 1);
});

test('resolves an allowed short link while retaining its appointment selection', async () => {
  const { scrape, calls } = fixture({ intercept: url => url.hostname === 'rink.as.me' ? new Response(null, { status: 302, headers: { location: 'https://app.acuityscheduling.com/schedule/rink' } }) : null });
  await scrape('https://rink.as.me/?appointmentType=1&calendarID=10', 1);
  assert.ok(calls.slice(2).every(url => url.searchParams.get('appointmentTypeId') === '1'));
  const redirected = fixture({ intercept: url => url.pathname === '/schedule.php' ? new Response(null, { status: 302, headers: { location: 'https://app.acuityscheduling.com/schedule/rink/?appointmentTypeIds[]=1&calendarIds=10' } }) : null });
  await redirected.scrape('https://app.acuityscheduling.com/schedule.php?owner=123&appointmentType=1&calendarID=10', 1);
  assert.ok(redirected.calls.slice(2).every(url => url.searchParams.get('appointmentTypeId') === '1' && url.searchParams.get('calendarId') === '10'));
});

test('retries rate limits a bounded number of times', async () => {
  let attempts = 0;
  const { scrape } = fixture({ sleep: async () => {}, intercept: url => {
    if (url.pathname.endsWith('/month') && ++attempts <= 2) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
  } });
  assert.deepEqual(await scrape(URL, 1), []);
  assert.equal(attempts, 3);
});

test('rejects the entire scrape when a later date fails rather than exporting partial results', async () => {
  const { scrape } = fixture({ available: ['2026-10-18', '2026-10-19'], slots: { '2026-10-18': [{ time: '2026-10-18T09:00:00-0500', slotsAvailable: 1 }] }, intercept: url => url.searchParams.get('startDate') === '2026-10-19' ? new Response(null, { status: 403 }) : null });
  await assert.rejects(scrape(URL), /HTTP 403/);
});

test('detects upstream format changes and invalid spaces', async () => {
  for (const payload of [[], { error: 'unexpected' }, {}]) {
    const { scrape } = fixture({ intercept: url => url.pathname.endsWith('/month') ? Response.json(payload) : null });
    await assert.rejects(scrape(URL), /monthly availability format/);
  }
  const { scrape } = fixture({ available: ['2026-10-18'], slots: { '2026-10-18': [{ time: '2026-10-18T09:00:00-0500', slotsAvailable: 'eight' }] } });
  await assert.rejects(scrape(URL), /invalid spaces/);
});

test('bounds inputs, response sizes, redirects and cancellation', async () => {
  const { scrape } = fixture();
  await assert.rejects(scrape('https://example.com'), { status: 400 });
  await assert.rejects(scrape(URL, 61), { status: 400 });
  const big = fixture({ intercept: () => new Response('large', { headers: { 'content-length': '9999999' } }) });
  await assert.rejects(big.scrape(URL), /too large/);
  const loop = fixture({ intercept: () => new Response(null, { status: 302, headers: { location: URL } }) });
  await assert.rejects(loop.scrape(URL), /too many/);
  assert.equal(loop.calls.length, 6);
  await assert.rejects(scrape(URL, 60, { signal: AbortSignal.abort() }), { status: 504 });
});
