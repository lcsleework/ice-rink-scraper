'use strict';

const APP_HOST = 'app.acuityscheduling.com';
const SCHEDULE_PATH = /^\/schedule\/([a-zA-Z0-9]+)(?:\/appointment\/(\d+))?(?:\/calendar\/(\d+))?\/?$/;
const ID = /^[1-9]\d*$/;

function validateUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    return { ok: false, message: 'Enter a valid Acuity scheduling URL.' };
  }
  let url;
  try { url = new URL(value.trim()); } catch {
    return { ok: false, message: 'Enter a valid Acuity scheduling URL.' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { ok: false, message: 'Use an HTTPS scheduling link without credentials or a custom port.' };
  }
  const isShortLink = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+as\.me$/.test(url.hostname);
  if (url.hostname !== APP_HOST && !isShortLink) {
    return { ok: false, message: 'Only app.acuityscheduling.com and Acuity *.as.me links are supported.' };
  }
  const match = url.pathname.match(SCHEDULE_PATH);
  const legacy = url.pathname === '/schedule.php';
  if (!(url.hostname === APP_HOST ? match || legacy : url.pathname === '/' || legacy)) {
    return { ok: false, message: 'Use a public Acuity schedule link, not a booking or account link.' };
  }
  // Do not silently widen a link that filters the visible appointment list.
  if (['appointmentTypeCategory', 'category', 'categories', 'categories[]'].some(key => url.searchParams.has(key))) {
    return { ok: false, message: 'Choose an appointment type and paste its direct scheduling link.' };
  }
  const selectionKeys = ['owner', 'appointmentType', 'appointmentTypeIds[]', 'appointmentTypeIds', 'calendarID', 'calendarIds', 'calendarIds[]'];
  for (const key of selectionKeys) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1 || (values.length && !ID.test(values[0]) && !(key.startsWith('calendar') && values[0] === 'any'))) {
      return { ok: false, message: `The scheduling link has an invalid ${key} value. Use a direct link to one appointment/calendar.` };
    }
  }
  if (legacy && url.hostname === APP_HOST && !url.searchParams.has('owner')) {
    return { ok: false, message: 'The scheduling link is missing its owner ID.' };
  }
  const appointmentIds = [match?.[2], ...['appointmentType', 'appointmentTypeIds[]', 'appointmentTypeIds'].map(key => url.searchParams.get(key))].filter(Boolean);
  const calendarIds = [match?.[3], ...['calendarID', 'calendarIds', 'calendarIds[]'].map(key => url.searchParams.get(key))].filter(Boolean);
  const appointmentTypeId = appointmentIds[0] || null;
  const calendarId = calendarIds[0] || null;
  if ((appointmentTypeId && !ID.test(appointmentTypeId)) || (calendarId && calendarId !== 'any' && !ID.test(calendarId))) {
    return { ok: false, message: 'The scheduling link contains an invalid appointment or calendar ID.' };
  }
  if (new Set(appointmentIds).size > 1 || new Set(calendarIds).size > 1) {
    return { ok: false, message: 'The scheduling link contains conflicting appointment or calendar IDs.' };
  }
  // Preserve only selection parameters. Tracking, booking and timezone overrides are irrelevant.
  for (const key of [...url.searchParams.keys()]) {
    if (!selectionKeys.includes(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return { ok: true, url: url.href, appointmentTypeId, calendarId: calendarId === 'any' ? null : calendarId };
}

module.exports = { validateUrl };
