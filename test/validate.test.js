'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateUrl } = require('../validate');

test('accepts and scopes the supplied appointment link', () => {
  const result = validateUrl(' https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344?utm_source=test#calendar ');
  assert.equal(result.ok, true);
  assert.equal(result.appointmentTypeId, '14752819');
  assert.equal(result.calendarId, '7377344');
  assert.equal(new URL(result.url).search, '');
});

test('accepts legacy, general schedule, and Acuity short links', () => {
  for (const url of ['https://app.acuityscheduling.com/schedule/abdd2b57', 'https://rink.as.me/', 'https://rink.as.me/?appointmentType=123', 'https://app.acuityscheduling.com/schedule.php?owner=19790920&appointmentType=14752819&calendarID=any']) {
    assert.equal(validateUrl(url).ok, true, url);
  }
  const redirected = validateUrl('https://app.acuityscheduling.com/schedule/abdd2b57/?appointmentTypeIds[]=14752819&calendarIds=7377344');
  assert.equal(redirected.ok, true);
  assert.equal(redirected.appointmentTypeId, '14752819');
  assert.equal(redirected.calendarId, '7377344');
  assert.equal(validateUrl('https://rink.as.me/?appointmentTypeIds[]=1&appointmentTypeIds[]=2').ok, false);
  assert.equal(validateUrl('https://rink.as.me/?calendarIds=10,20').ok, false);
  assert.equal(validateUrl('https://rink.as.me/?appointmentType=1&appointmentTypeIds[]=2').ok, false);
});

test('rejects unsafe hosts, protocols, paths, credentials and ambiguous selections', () => {
  for (const url of [undefined, {}, '', 'x', 'http://app.acuityscheduling.com/schedule/a', 'https://localhost/', 'https://127.0.0.1/', 'https://app.acuityscheduling.com.evil.test/schedule/a', 'https://evilas.me/', 'https://as.me/', 'https://user:secret@app.acuityscheduling.com/schedule/a', 'https://app.acuityscheduling.com:8443/schedule/a', 'https://app.acuityscheduling.com/api/scheduling/v1/appointments', 'https://app.acuityscheduling.com/schedule.php', 'https://app.acuityscheduling.com/schedule/a?appointmentType=1&appointmentType=2', 'https://app.acuityscheduling.com/schedule/a/appointment/1?appointmentType=2', 'https://rink.as.me/?category=Private', 'https://app.acuityscheduling.com/schedule/a/appointment/0', 'https://rink.as.me/booking/123']) {
    assert.equal(validateUrl(url).ok, false, String(url));
  }
});
