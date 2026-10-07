'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { validateUrl } = require('./validate');

// Public requests observed in the scheduler's Network panel; no API key or booking actions.
const API_BASE = 'https://app.acuityscheduling.com/api/scheduling/v1/availability/';
const REQUEST_TIMEOUT_MS = 20_000;
const SCRAPE_TIMEOUT_MS = 150_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS = 30;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

class ScrapeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ScrapeError';
    this.status = status;
  }
}

function formatDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = name => parts.find(p => p.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function* monthsBetween(start, end) {
  let month = `${start.slice(0, 7)}-01`;
  while (month <= end) {
    yield month;
    const value = new Date(`${month}T12:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + 1);
    month = value.toISOString().slice(0, 10);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readBusiness(html) {
  const match = /\b(?:var|let|const)\s+BUSINESS\s*=\s*\{/.exec(html);
  if (!match) throw new ScrapeError('This page does not expose the supported Acuity scheduler. Use its direct appointment link.');
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const business = JSON.parse(html.slice(start, index + 1));
        if (!business.ownerKey || !isObject(business.appointmentTypes) || !isObject(business.calendars)) break;
        return business;
      } catch { break; }
    }
  }
  throw new ScrapeError('Acuity returned unexpected schedule metadata. The scraper may need an update.');
}

function getTargets(business, selection) {
  const types = Object.values(business.appointmentTypes).flat();
  const calendars = Object.values(business.calendars).flat();
  const selected = types.filter(type => type.active !== false &&
    (selection.appointmentTypeId ? String(type.id) === selection.appointmentTypeId : !type.private));
  const targets = new Map();
  for (const type of selected) {
    if (!type.name || !Number.isFinite(type.duration) || type.duration <= 0 || !Array.isArray(type.calendarIDs)) {
      throw new ScrapeError('An appointment is missing its name, duration or calendar. The scraper may need an update.');
    }
    for (const calendarId of type.calendarIDs) {
      if (selection.calendarId && String(calendarId) !== selection.calendarId) continue;
      const calendar = calendars.find(item => String(item.id) === String(calendarId));
      const timeZone = calendar?.timezone || business.timezone;
      try { new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'invalid' }).format(); } catch {
        throw new ScrapeError('The schedule does not provide a valid rink timezone.');
      }
      targets.set(`${type.id}:${calendarId}`, { type, calendarId, timeZone });
    }
  }
  if (!targets.size) throw new ScrapeError('No appointments match this link. Check its appointment and calendar IDs.', 422);
  if (targets.size > MAX_TARGETS) throw new ScrapeError('This schedule is too large. Paste a direct link to one appointment type.', 422);
  return [...targets.values()];
}

async function readLimited(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ScrapeError('The scheduling response is too large.');
  }
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new ScrapeError('The scheduling response is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createScraper({ fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = SCRAPE_TIMEOUT_MS, sleep = delay } = {}) {
  return async function scrape(url, days = 60, { signal } = {}) {
    const initial = validateUrl(url);
    if (!initial.ok) throw new ScrapeError(initial.message, 400);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new ScrapeError('Days must be an integer from 1 to 60.', 400);
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const currentTime = now();

    async function request(address) {
      for (let attempt = 0; attempt < 3; attempt++) {
        deadline.throwIfAborted();
        let response;
        try {
          response = await fetchImpl(address, {
            redirect: 'manual',
            signal: AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            headers: { accept: 'application/json, text/html;q=0.9', 'user-agent': 'IceRinkScheduleExporter/1.0' },
          });
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            const retryAfter = Number(response.headers.get('retry-after'));
            await response.body?.cancel();
            await sleep(Math.min(5000, Math.max(500 * (2 ** attempt), Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)), undefined, { signal: deadline });
            continue;
          }
          if (response.status >= 300 && response.status < 400) return { response };
          if (!response.ok) {
            await response.body?.cancel();
            throw new ScrapeError(response.status === 429
              ? 'Acuity is limiting requests. Please try again in a few minutes.'
              : `Acuity could not load the schedule (HTTP ${response.status}).`, response.status === 429 ? 503 : 502);
          }
          return { response, body: await readLimited(response) };
        } catch (error) {
          if (error instanceof ScrapeError || deadline.aborted) throw error;
          if (attempt === 2) throw new ScrapeError('Could not reach Acuity. Please try again.');
          await sleep(500 * (2 ** attempt), undefined, { signal: deadline });
        }
      }
    }

    async function json(endpoint, params) {
      const address = new URL(endpoint, API_BASE);
      address.search = new URLSearchParams(params).toString();
      const { response, body } = await request(address.href);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ScrapeError('Acuity redirected an availability request unexpectedly.');
      }
      try { return JSON.parse(body); } catch {
        throw new ScrapeError('Acuity returned an unexpected availability response. Please try again.');
      }
    }

    try {
      let selection = initial;
      let pageUrl = initial.url;
      let html;
      for (let hops = 0; hops <= 5; hops++) {
        const result = await request(pageUrl);
        if (result.response.status < 300) { html = result.body; break; }
        const location = result.response.headers.get('location');
        await result.response.body?.cancel();
        if (!location || hops === 5) throw new ScrapeError('The scheduling link has too many or invalid redirects.');
        const next = validateUrl(new URL(location, pageUrl).href);
        if (!next.ok) throw new ScrapeError('The scheduling link redirects outside supported Acuity schedule pages.', 400);
        selection = { ...next, appointmentTypeId: next.appointmentTypeId || selection.appointmentTypeId, calendarId: next.calendarId || selection.calendarId };
        pageUrl = next.url;
      }
      const business = readBusiness(html);
      const targets = getTargets(business, selection);
      const records = new Map();
      for (const { type, calendarId, timeZone } of targets) {
        const start = formatDateKey(currentTime, timeZone);
        // Follow plan.md literally: today through today + days, both dates included.
        const end = addDays(start, days);
        const params = { owner: business.ownerKey, appointmentTypeId: String(type.id), calendarId: String(calendarId), timezone: timeZone };
        const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' });
        const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
        for (const month of monthsBetween(start, end)) {
          const availability = await json('month', { ...params, month });
          if (!isObject(availability) || !Object.keys(availability).length || Object.entries(availability).some(([date, available]) => !DATE_KEY.test(date) || date.slice(0, 7) !== month.slice(0, 7) || typeof available !== 'boolean')) {
            throw new ScrapeError('Acuity changed its monthly availability format. The scraper needs an update.');
          }
          const dates = Object.keys(availability).filter(date => availability[date] && date >= start && date <= end).sort();
          for (const date of dates) {
            const times = await json('times', { ...params, startDate: date });
            if (!isObject(times) || Object.entries(times).some(([key, slots]) => !DATE_KEY.test(key) || !Array.isArray(slots))) {
              throw new ScrapeError('Acuity changed its time slot format. The scraper needs an update.');
            }
            // The endpoint can return other dates. Each available day is fetched explicitly.
            for (const slot of times[date] || []) {
              if (!isObject(slot) || typeof slot.time !== 'string' || !OFFSET_TIME.test(slot.time)) {
                throw new ScrapeError('Acuity returned a time slot without a valid timestamp.');
              }
              const instant = new Date(slot.time);
              if (!Number.isFinite(instant.getTime())) throw new ScrapeError('Acuity returned an invalid event date.');
              const eventDay = formatDateKey(instant, timeZone);
              if (eventDay !== date) throw new ScrapeError('Acuity returned a time slot on an unexpected date.');
              const spots = business.hideSpotsClasses && type.type === 'class' || business.hideSpotsServices && type.type !== 'class'
                ? null : slot.slotsAvailable ?? null;
              if (spots !== null && (!Number.isInteger(spots) || spots < 0)) throw new ScrapeError('Acuity returned an invalid spaces remaining value.');
              if (eventDay < start || eventDay > end || instant < currentTime) continue;
              const event = {
                eventType: type.name.trim().toLowerCase(),
                eventDate: dateFormat.format(instant),
                eventTime: `${timeFormat.format(instant)} - ${timeFormat.format(new Date(instant.getTime() + type.duration * 60_000))}`,
                spotsLeft: spots,
              };
              records.set(`${type.id}:${calendarId}:${instant.toISOString()}`, { instant: instant.getTime(), event });
            }
          }
        }
      }
      return [...records.values()].sort((a, b) => a.instant - b.instant || a.event.eventType.localeCompare(b.event.eventType)).map(record => record.event);
    } catch (error) {
      if (deadline.aborted) throw new ScrapeError(signal?.aborted ? 'The scrape was cancelled.' : 'The schedule took too long to load. Please try again or use a link to one appointment type.', 504);
      if (error instanceof ScrapeError) throw error;
      throw new ScrapeError('The scheduling page could not be read. The scraper may need an update.');
    }
  };
}

module.exports = { scrape: createScraper(), createScraper, ScrapeError };
