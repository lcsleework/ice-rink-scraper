# Ice Rink Schedule Exporter

A Node.js 22 HTTP Google Cloud Function with a small web page: paste an Acuity scheduling link, scrape its published sessions, and download a JSON array. The source, lockfile, tests, and deployment command are included.

## Run locally

Install Node.js **22**, then run from this directory:

```sh
npm ci
npm test
npm start
```

Open **http://localhost:8080**. The supplied Rocket Ice link is prefilled. Click **Scrape schedule**, then **Download JSON**. An empty schedule can also be downloaded as `[]`. There is no database, login, browser installation, API key, or environment file to configure.

To print a JSON array directly, without starting the web server:

```sh
node scripts/scrape.js
```

To scrape another link and save UTF-8 JSON (works in PowerShell and Bash):

```sh
node scripts/scrape.js "https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344" events-rink.json
```

The first argument is the URL; the optional second argument is an output filename. Use the filename argument on Windows to avoid shell-specific redirection encodings. The CLI prints failures to stderr and exits with a nonzero status.

## Output and scope

The download is a valid JSON **array**, using the client's four fields:

```json
[
  {
    "eventType": "stick & puck ice time - rink side b - one on one private lessons allowed",
    "eventDate": "October 18, 2026",
    "eventTime": "7:30 AM - 8:30 AM",
    "spotsLeft": 8
  }
]
```

- `eventType`: the full appointment name, lowercased as specified in the plan. It is not shortened to the template's generic “stick & puck,” which would lose the Side A/Side B distinction.
- `eventDate`: the event's start date in the selected calendar's timezone.
- `eventTime`: the start time and start time plus the appointment's published duration, formatted in that timezone. The public page hides the duration for this rink, but its metadata supplies 60 minutes. A session crossing midnight still uses its start date. The requested schema has no end-date or UTC-offset field.
- `spotsLeft`: a nonnegative integer, or `null` when unavailable or hidden. A returned slot with zero spaces is preserved. Sessions that Acuity hides entirely, including fully booked days marked unavailable, cannot be recovered from public availability.

**Window:** follows `plan.md` literally: today through **today + 60 days**, including both endpoint dates (61 calendar dates). “Today” is evaluated in the rink's timezone. Already-started sessions are omitted. On October 7, 2026, the last included date is December 6, 2026. For exactly 60 calendar dates including today, change the HTTP handler's call to `scrapeSchedule(url, 59, ...)` and update the UI wording.

Results are sorted by start instant, then appointment name. Duplicate upstream records are removed using appointment ID, calendar ID, and start instant. Different calendars remain distinct even if their four exported fields happen to match.

A link selecting an appointment/calendar keeps that scope, including legacy `appointmentType`/`calendarID` query parameters and modern `appointmentTypeIds[]`/`calendarIds` redirects. A general schedule link covers its public, active appointment types and associated calendars. Category-filtered links and links selecting multiple IDs are rejected with instructions to choose a direct appointment link. Custom forms, appointment booking, add-ons, and group quantity are outside scope. The exporter reads availability for one participant and does not book anything.

## HTTP API

`GET /` serves the page. `POST /scrape` accepts `Content-Type: application/json`:

```json
{
  "url": "https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344"
}
```

The HTTP response follows the plan's envelope:

```json
{
  "count": 1,
  "events": [
    {
      "eventType": "stick & puck ice time - rink side b - one on one private lessons allowed",
      "eventDate": "October 18, 2026",
      "eventTime": "7:30 AM - 8:30 AM",
      "spotsLeft": 8
    }
  ]
}
```

The page downloads only `events`, without the envelope. Errors return `{ "error": "..." }`: invalid input is 400, unsupported selection is 422, concurrent requests are 429, upstream failures are 502/503, and the overall deadline is 504. Unsupported media types are 415. Malformed JSON is rejected by the Functions Framework before the handler. Failed scrapes do not return partial event lists.

Programmatic use:

```js
const { scrape } = require('./scraper');
const events = await scrape(url, 60); // Returns the array directly.
```

The optional third argument accepts `{ signal }` for cancellation. `days` must be an integer from 1 through 60. The web endpoint fixes the horizon at 60; it does not accept a client-supplied horizon.

## Discovery and the decision to use HTTP

Discovery was completed against the [supplied Rocket Ice schedule](https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344) on **October 7, 2026**, including a real Chrome session and its Fetch/XHR traffic.

The implementation uses **Option B**, explicitly allowed by Phase 0 of `plan.md`. The following public requests work with Node's built-in `fetch`, without cookies or authentication:

```text
GET https://app.acuityscheduling.com/api/scheduling/v1/availability/month
    ?owner=abdd2b57&appointmentTypeId=14752819&calendarId=7377344
    &timezone=America%2FChicago&month=2026-10-01

GET https://app.acuityscheduling.com/api/scheduling/v1/availability/times
    ?owner=abdd2b57&appointmentTypeId=14752819&calendarId=7377344
    &timezone=America%2FChicago&startDate=2026-10-18
```

The month parameter must be a **full date**, not `YYYY-MM`. The month response is a date-to-boolean map. The times response is a date-to-slots map:

```json
{
  "2026-10-18": [
    { "time": "2026-10-18T07:30:00-0500", "slotsAvailable": 8 }
  ]
}
```

The HTML embeds a JSON `BUSINESS` object containing appointment names, durations, calendar associations and IANA timezones. It is parsed as JSON without evaluating any upstream JavaScript. Events are fetched separately. The actual rink is **Rocket Ice, Bolingbrook, Illinois**, and its metadata specifies **America/Chicago**; the Denver example in the plan does not apply.

Browser observations for maintenance:

| Element/data | Observed behavior |
| --- | --- |
| Month navigation | `button[aria-label="Next month"]`, `button[aria-label="Previous month"]` |
| Month selection | `button[aria-label="Open month picker"]` |
| Day selection | Numbered day buttons; selecting one requests `availability/times` |
| Time slots | Buttons labelled, for example, `7:30 AM, 8 spots left` |
| Appointment scope | URL selects appointment `14752819`, calendar `7377344` |
| Schedule notice | The rink publishes each month about two weeks in advance |

Consequently, the scraper checks every month intersecting the requested window, including months after an empty one. It exports what the rink has published; it cannot predict unreleased sessions. November and early December were unpublished during verification.

These are undocumented public scheduler endpoints, not Acuity's authenticated developer API. If Acuity changes them, update `API_BASE`, the `json('month', ...)`/`json('times', ...)` parameters and response validation in `scraper.js`. If bootstrap metadata changes, update `readBusiness()`/`getTargets()`. Recheck DevTools before changing assumptions, then run `npm test` and compare a live export against the page. There are no production DOM selectors or Chromium dependencies to update. A browser fallback is not included; unexpected formats produce an explicit failure.

## Deploy to Google Cloud Functions, second generation

Prerequisites: the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), a billed Google Cloud project, and permission to enable services, deploy functions, and set invocation access. [Node.js 22 is a supported runtime](https://docs.cloud.google.com/functions/docs/runtime-support).

Authenticate and select your project:

```sh
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Run this single command from the project directory (PowerShell or Bash):

```sh
gcloud functions deploy ice-rink-scraper --gen2 --runtime=nodejs22 --region=us-west1 --source=. --entry-point=app --trigger-http --allow-unauthenticated --memory=512MiB --timeout=180s --max-instances=2 --concurrency=1
```

The [deployment flags](https://docs.cloud.google.com/sdk/gcloud/reference/functions/deploy) select the Node.js 22 runtime and the `app` HTTP entry point. Fetch-only scraping removes the plan's Chromium memory requirement. The internal 150-second deadline leaves room for a friendly response within the function's 180-second timeout.

Get the URL:

```sh
gcloud functions describe ice-rink-scraper --gen2 --region=us-west1 --format="value(serviceConfig.uri)"
```

Open that URL, scrape the default link, and download a file as the deployment smoke test. `.gcloudignore` excludes dependencies, local discovery artifacts, tests and CLI scripts from uploads; Google installs the locked production dependencies during the build.

The command creates a public MVP endpoint. Maximum instances and one job per instance bound concurrent work; they are not per-user rate limits or a spending cap. For a private deployment use IAM invocation controls and an authenticated access path. No deployment was performed in the implementation environment: `gcloud` is not installed and no target Google Cloud project was supplied.

## Verification

`npm test` runs 20 offline tests using Node's built-in test runner. They cover URL validation and redirects, selected appointment scope, date boundaries, a UTC/local-date mismatch, year rollover, daylight saving, sorting/deduplication, hidden/missing/zero spaces, empty months, bounded retries, failures without partial results, response limits, cancellation, and HTTP routing/concurrency.

Live checks completed on October 7, 2026 with Node.js 22.23.2:

- Two consecutive complete scrapes succeeded; the UI run returned **220 events in about 20 seconds**.
- All five October 18 start times and remaining-space counts matched the rendered calendar. End times were checked against the published 60-minute duration.
- Browser validation, preview, the actual downloaded JSON file, and a 390px mobile layout were checked. The downloaded array matched the HTTP response exactly; no browser JavaScript errors occurred.
- `npm audit` reported **zero vulnerabilities** after a narrowly scoped `cloudevents` → `uuid@11.1.1` override. This CommonJS-compatible release fixes [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). The framework's CloudEvents UUID generation was checked after the override.
- Real Google Cloud deployment remains unverified; use the deployment smoke test above.

Availability counts are a snapshot and will change as people book. Offline tests do not contact the rink. For a fresh live check, run the CLI or use the page; avoid repeatedly scraping in a tight loop.

## Files

```text
index.js              HTTP function, validation and routing
scraper.js            Public availability requests and event normalization
validate.js           Schedule URL allowlist and selection parsing
public/index.html     Responsive UI, preview and JSON download
scripts/scrape.js      Standalone CLI using the same scraper
test/                 Offline regression tests
package.json          Node.js 22 runtime and Functions Framework dependency
package-lock.json     Reproducible dependency versions
plan.md               Original implementation plan
```

Requests are sequential, with at most three attempts for transient failures, 20 seconds per request, a 150-second overall deadline, bounded response sizes and at most 30 appointment/calendar combinations. Very large schedules receive an error directing the user to a specific appointment link. HTTPS host/path checks are reapplied to every page redirect, API requests are sent only to the fixed Acuity origin, and external redirects are rejected.
