'use strict';

const { scrape } = require('../scraper');
const { writeFile } = require('node:fs/promises');
const DEFAULT_URL = 'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344';

scrape(process.argv[2] || DEFAULT_URL, 60)
  .then(async events => {
    const json = `${JSON.stringify(events, null, 2)}\n`;
    if (process.argv[3]) {
      await writeFile(process.argv[3], json, 'utf8');
      console.error(`Saved ${events.length} events to ${process.argv[3]}`);
    } else process.stdout.write(json);
  })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
