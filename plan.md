# Plan: Ice Rink Schedule Scraper (MVP)

## 1. Goal

A tiny web tool where the client:

1. Pastes an Acuity Scheduling link into a text box.
2. Clicks **Scrape**.
3. Downloads a JSON file with every event for the next 60 days.

The client also wants the **code itself** (Node.js 22, deployable as a Google Cloud Function), not just a hosted endpoint.

### Output format

The template in the brief is not valid JSON (missing commas, stray braces). The output will be a valid JSON array with these fields:

```json
[
  {
    "eventType": "stick & puck",
    "eventDate": "October 18, 2026",
    "eventTime": "7:30 AM - 8:30 AM",
    "spotsLeft": 8
  }
]
```

## 2. Key finding about the target site

The page at `app.acuityscheduling.com/schedule/...` is rendered by JavaScript. A plain HTTP fetch returns only an empty shell with metadata (title: "Rocket Ice Skating Rink", owner id `19790920`). No events are in the raw HTML.

That means a simple `fetch` + `cheerio` approach will **not** work. There are two options:

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Headless browser** (chosen for MVP) | Puppeteer loads the page, clicks through the calendar, reads the DOM | Works exactly like a real visitor; resilient to hidden APIs | Heavier, slower, needs more memory |
| B. Call Acuity's internal XHR endpoints directly | Find the request the page makes for availability and replay it | Fast and light | Undocumented, may change, needs reverse engineering |

**Decision:** build with Option A. During the discovery step (Phase 0), check the browser's Network tab. If a clean JSON or HTML availability request is visible, switch to Option B, which would be a drop-in replacement for the scraper module.

## 3. Scope

**In scope**
- One page with a URL input, a Scrape button, a status message, and a Download button.
- Scrape today through today + 60 days.
- Fields: event type, date, time range, spots left.
- JSON download.
- Basic error messages.

**Out of scope for MVP**
- Authentication, user accounts, saved history.
- Scheduling or recurring scrapes.
- Database storage.
- CSV/Excel export (easy to add later).
- Multiple links at once.
- Booking or any write action on the site.

## 4. Architecture

One Google Cloud Function (2nd gen, HTTP trigger) that does two things:

```
Browser (client)
   │  GET /            → returns the HTML page (simple UI)
   │  POST /scrape     → { "url": "..." }  → runs scraper → returns JSON
   ▼
Cloud Function (Node.js 22)
   ├── index.js          entry point + routing
   ├── scraper.js        Puppeteer logic
   ├── validate.js       URL checks
   └── public/index.html UI (inline JS, no framework)
```

Why a single function: it keeps deployment to one command and matches "run as a Google Function". The UI is static HTML served by the same function, so there is no second service to host.

### Download approach

The UI calls `POST /scrape`, receives the JSON array, builds a `Blob`, and triggers a download as `events-YYYY-MM-DD.json`. No file is stored on the server.

## 5. Project structure

```
ice-rink-scraper/
├── package.json
├── index.js
├── scraper.js
├── validate.js
├── public/
│   └── index.html
├── README.md
└── plan.md
```

## 6. Tech stack

- **Runtime:** Node.js 22
- **Functions framework:** `@google-cloud/functions-framework`
- **Browser automation:** `puppeteer-core` + `@sparticuz/chromium` (a Chromium build made for serverless, since full Puppeteer's bundled Chromium is too large and lacks system libraries on Cloud Functions)
- **Date handling:** native `Date` or `date-fns`
- **UI:** plain HTML, CSS, vanilla JS

`package.json` essentials:

```json
{
  "name": "ice-rink-scraper",
  "version": "1.0.0",
  "main": "index.js",
  "engines": { "node": "22" },
  "scripts": {
    "start": "functions-framework --target=app --port=8080"
  },
  "dependencies": {
    "@google-cloud/functions-framework": "^3.4.0",
    "@sparticuz/chromium": "^latest",
    "puppeteer-core": "^latest"
  }
}
```

## 7. Build phases

### Phase 0: Discovery (about 1-2 hours)

Do this before writing real code.

1. Open the link in Chrome with DevTools (Network tab, filter XHR/Fetch).
2. Note how the calendar works: month view, clicking a day shows time slots, how "spots left" is displayed (for example "8 spots left").
3. Note how the event type is shown (appointment type name, such as "Stick & Puck").
4. Check whether the link is tied to one appointment type (`appointment/14752819`) or whether other types appear on the same calendar. Decide whether the scraper should loop through all types or only the one in the link. **MVP default: scrape whatever the given link shows.**
5. Capture stable CSS selectors or `aria` labels for: day cells, available-time buttons, spots-left text, month "next" button.
6. Check whether an XHR returns availability as JSON/HTML. If yes, consider Option B.

**Deliverable:** a short notes list of selectors and behaviors, added to README.

### Phase 1: Scraper core, local (about half a day)

Write `scraper.js` exporting `scrape(url, days = 60)`.

Algorithm:

1. Compute `startDate = today` and `endDate = today + 60 days`.
2. Launch Chromium, open the URL, wait for the calendar to render.
3. Loop over months from the current month until the month containing `endDate`:
   1. Find all day cells that are enabled (have availability).
   2. Skip any date beyond `endDate`.
   3. For each enabled day, click it and wait for the time list to render.
   4. For each time slot, read:
      - `eventTime` (the start time; build the range if the end time is shown separately, or read it from the label)
      - `spotsLeft` (parse the integer from text such as "8 spots left")
      - `eventType` (from the page heading or appointment type name, lowercased to match the template)
      - `eventDate` formatted as `Month D, YYYY`
   5. Push each record to the results array.
4. Click "next month" and repeat.
5. Close the browser (always, in a `finally` block).
6. Return the array, sorted by date then start time.

Implementation notes:
- Use explicit waits (`waitForSelector`, or wait for network idle after a click), not fixed sleeps, wherever possible.
- Block images, fonts, and media via request interception to speed things up.
- Set a reasonable viewport and a normal user agent.
- Treat "spots left" absent text as `null`, and sold-out slots as `0` if they are shown.
- Format dates with `toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })`, in the rink's timezone (`America/Denver` for Salt Lake City; confirm with the client).

Test locally with `npm start` and a quick script that prints the result.

### Phase 2: Input validation (about 1 hour)

`validate.js`:

- Must be a valid `https` URL.
- Hostname must be `app.acuityscheduling.com` (or `*.as.me` if the client uses short links).
- Reject everything else with a 400 error.

This is important: without it, the function becomes an open proxy that can fetch any URL.

### Phase 3: HTTP handler and UI (about 2-3 hours)

`index.js`:

```js
const functions = require('@google-cloud/functions-framework');
const fs = require('fs');
const path = require('path');
const { scrape } = require('./scraper');
const { validateUrl } = require('./validate');

functions.http('app', async (req, res) => {
  if (req.method === 'GET') {
    res.set('Content-Type', 'text/html');
    return res.send(fs.readFileSync(path.join(__dirname, 'public/index.html')));
  }

  if (req.method === 'POST' && req.path.endsWith('/scrape')) {
    try {
      const { url } = req.body;
      const check = validateUrl(url);
      if (!check.ok) return res.status(400).json({ error: check.message });

      const events = await scrape(url, 60);
      return res.json({ count: events.length, events });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Scraping failed. Please try again.' });
    }
  }

  res.status(404).send('Not found');
});
```

`public/index.html`:

- Text input (URL), pre-filled with the example link.
- **Scrape** button, disabled while running.
- Status line: "Scraping, this may take a minute…", then "Found 42 events".
- **Download JSON** button, shown only when results exist.
- Optional: a collapsible `<pre>` preview of the first few results.
- Download logic: `new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' })` with an `<a download>` link.

### Phase 4: Deploy to Google Cloud Functions (about 1-2 hours)

```bash
gcloud functions deploy ice-rink-scraper \
  --gen2 \
  --runtime=nodejs22 \
  --region=us-west1 \
  --source=. \
  --entry-point=app \
  --trigger-http \
  --allow-unauthenticated \
  --memory=2GiB \
  --timeout=540s
```

Notes:
- 2 GiB memory is recommended for headless Chromium; 1 GiB may crash.
- Timeout is raised because walking about 60 days of calendar pages can take a while. If runs approach the limit, see "Risks" below.
- `--allow-unauthenticated` is fine for a demo MVP, but see the security note.
- Confirm Node.js 22 is available in the chosen region at deploy time; if not, ask the client whether Node 20 is acceptable as a fallback (they asked for 22, so don't change it without saying so).

### Phase 5: Testing and handoff (about half a day)

Manual test checklist:

- [ ] Valid link returns events; count looks plausible against the live site.
- [ ] Spot-check 5 events (date, time, spots left) against the website.
- [ ] First and last day of the 60-day window are handled correctly (no events beyond day 60).
- [ ] Days with no availability are skipped without errors.
- [ ] Invalid URL shows a friendly error.
- [ ] A non-Acuity URL is rejected.
- [ ] Downloaded file is valid JSON (open it in an editor or run `JSON.parse`).
- [ ] Run time is acceptable (target: under about 3 minutes).
- [ ] Run twice in a row; second run works (no leftover browser state).

Handoff:
- README with: install, run locally, deploy command, how to change the 60-day window, how to update selectors if Acuity changes its markup.
- Share the repo or a zip, plus the deployed URL.

## 8. Time estimate

| Phase | Estimate |
|---|---|
| 0. Discovery | 1-2 h |
| 1. Scraper core | 4 h |
| 2. Validation | 1 h |
| 3. Handler + UI | 2-3 h |
| 4. Deploy | 1-2 h |
| 5. Testing + handoff | 4 h |
| **Total** | **about 2-3 working days** |

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Acuity changes its markup | Scraper breaks | Keep all selectors in one config object at the top of `scraper.js`; document them |
| Run exceeds the function timeout | Request fails | Block heavy assets; if still slow, scrape days in parallel pages (limit to 3-4), or move the same code to Cloud Run (no code rewrite, just a Dockerfile) |
| Chromium fails to start in the function | Deploy works but scrape fails | Use `@sparticuz/chromium` with `--no-sandbox`; test on a real deploy early (end of Phase 1, not at the end of the project) |
| Site rate-limits or blocks automated access | Partial results | Add a small delay between clicks; check the site's terms of use with the client before production use |
| Public, unauthenticated endpoint can be abused | Cost and abuse | URL allow-list (Phase 2); set `--max-instances=2`; for production, add a simple shared key or IAM auth |
| Timezone mistakes shift dates by one day | Wrong data | Use the rink's timezone explicitly when formatting dates |
| Template in the brief is invalid JSON | Client confusion | Output valid JSON and tell the client up front |

## 10. Open questions for the client

1. Does the link cover one event type ("Stick & Puck") only, or should the tool scrape every appointment type at the rink?
2. Is `eventType` expected in lowercase, as in the template?
3. Should sold-out sessions be included (with `spotsLeft: 0`) or left out?
4. Is a public, no-login page acceptable for the MVP?
5. Is the Node 22 requirement strict if a region does not offer it yet?

## 11. Future ideas (not in MVP)

- CSV export.
- Scheduled daily scrape saved to Cloud Storage.
- Support for multiple links in one run.
- Progress indicator (streaming or polling).
- Simple password or shared key on the endpoint.

## 12. Definition of done

- The client opens the URL, pastes the rink link, clicks Scrape, and downloads a valid JSON file.
- The file contains every event for the next 60 days in the agreed format.
- The code is delivered in a repo with a README and a working deploy command.
