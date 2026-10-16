'use strict';

const functions = require('@google-cloud/functions-framework');
const express = require('express');
const { scrape, ScrapeError } = require('./scraper');
const { validateUrl } = require('./validate');

const DEFAULT_URL = 'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344';

function createHandler(scrapeSchedule = scrape) {
  let busy = false;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const route = req.path.replace(/\/$/, '') || '/';
    if (route !== '/' && route !== '/scrape') return res.status(404).json({ error: 'Not found.' });
    const isGet = req.method === 'GET';
    if (!isGet && !(route === '/scrape' && req.method === 'POST')) {
      return res.set('Allow', route === '/' ? 'GET' : 'GET, POST').status(405).json({
        error: route === '/' ? 'Use GET to scrape a schedule.' : 'Use GET or POST to scrape a schedule.',
      });
    }
    if (!isGet) {
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send a JSON body with a url field.' });
      if (Number(req.get('content-length')) > 4096) return res.status(413).json({ error: 'The request is too large.' });
    }
    const url = isGet ? (req.query?.url === undefined ? DEFAULT_URL : req.query.url) : req.body?.url;
    const check = validateUrl(url);
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
// Match the entry point configured on the existing Cloud Run service.
functions.http('getRocketIce_StickPuck2', app);

// Vercel loads the default Express export; Google keeps the registered HTTP handler.
const server = express();
server.disable('x-powered-by');
server.use(express.json({ limit: '4kb' }));
server.use(app);
server.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
    return res.status(error.status).json({
      error: error.type === 'entity.too.large' ? 'The request is too large.' : 'Send a valid JSON body with a url field.',
    });
  }
  return next(error);
});

module.exports = server;
module.exports.app = app;
module.exports.createHandler = createHandler;
