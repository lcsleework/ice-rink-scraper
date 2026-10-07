'use strict';

const functions = require('@google-cloud/functions-framework');
const fs = require('node:fs');
const path = require('node:path');
const { scrape, ScrapeError } = require('./scraper');
const { validateUrl } = require('./validate');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function createHandler(scrapeSchedule = scrape) {
  let busy = false;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const route = req.path.replace(/\/$/, '') || '/';
    if ((req.method === 'GET' || req.method === 'HEAD') && route === '/') {
      return res.status(200).type('html').send(html);
    }
    if (route !== '/scrape') return res.status(404).json({ error: 'Not found.' });
    if (req.method !== 'POST') return res.set('Allow', 'POST').status(405).json({ error: 'Use POST to scrape a schedule.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send a JSON body with a url field.' });
    if (Number(req.get('content-length')) > 4096) return res.status(413).json({ error: 'The request is too large.' });
    const check = validateUrl(req.body?.url);
    if (!check.ok) return res.status(400).json({ error: check.message });
    if (busy) return res.set('Retry-After', '5').status(429).json({ error: 'A scrape is already running. Please try again shortly.' });
    busy = true;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const events = await scrapeSchedule(check.url, 60, { signal: controller.signal });
      return res.status(200).json({ count: events.length, events });
    } catch (error) {
      console.error('Schedule scrape failed:', error.message);
      return res.status(error instanceof ScrapeError ? error.status : 500).json({ error: error instanceof ScrapeError ? error.message : 'Scraping failed. Please try again.' });
    } finally {
      busy = false;
      res.off('close', onClose);
    }
  };
}

const app = createHandler();
functions.http('app', app);
module.exports = { app, createHandler };
