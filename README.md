# Ice Rink Schedule Exporter

A Node.js 22 JSON API for Google Cloud Functions or Vercel. Open the function URL with a GET request to scrape the default Rocket Ice schedule and receive JSON. No HTML file or `public` folder is required. The source, lockfile, tests, and deployment configuration are included.

## Run locally

Install Node.js **22**, then run from this directory:

```sh
npm ci
npm test
npm start
```

Open **http://localhost:8080**. This sends a GET request, scrapes the default Rocket Ice schedule, and displays JSON containing `count` and `events`. An empty schedule returns `{ "count": 0, "events": [] }`. Each GET runs a fresh scrape, so the response can take several seconds. There is no database, login, browser installation, API key, or environment file to configure.

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

The HTTP response's `events` field (and the standalone CLI output) is a JSON **array**, using the client's four fields:

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

**Window:** follows `plan.md` literally: today through **today + 60 days**, including both endpoint dates (61 calendar dates). “Today” is evaluated in the rink's timezone. Already-started sessions are omitted. On October 7, 2026, the last included date is December 6, 2026. For exactly 60 calendar dates including today, change the HTTP handler's call to `scrapeSchedule(url, 59, ...)` and update this documentation.

Results are sorted by start instant, then appointment name. Duplicate upstream records are removed using appointment ID, calendar ID, and start instant. Different calendars remain distinct even if their four exported fields happen to match.

A link selecting an appointment/calendar keeps that scope, including legacy `appointmentType`/`calendarID` query parameters and modern `appointmentTypeIds[]`/`calendarIds` redirects. A general schedule link covers its public, active appointment types and associated calendars. Category-filtered links and links selecting multiple IDs are rejected with instructions to choose a direct appointment link. Custom forms, appointment booking, add-ons, and group quantity are outside scope. The exporter reads availability for one participant and does not book anything.

## HTTP API

`GET /` and `GET /scrape` return the scraped schedule as JSON. With no `url` query parameter, they use this default Rocket Ice schedule:

```text
https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344
```

To scrape another supported Acuity link, supply it as a URL-encoded `url` query parameter on either route. For example, in PowerShell:

```powershell
$scheduleUrl = 'https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344'
$requestUrl = 'http://localhost:8080/?url=' + [uri]::EscapeDataString($scheduleUrl)
Invoke-RestMethod -Uri $requestUrl | ConvertTo-Json -Depth 10
```

GET requests need no body or `Content-Type` header. An explicitly empty or repeated `url` parameter is rejected with 400. Both routes use the same URL validation, timeout, cancellation, and concurrency limits as POST. `HEAD` and unsupported methods return 405 without starting a scrape; unknown routes return 404.

The existing `POST /scrape` endpoint remains available and requires `Content-Type: application/json` with a URL in the body:

```json
{
  "url": "https://app.acuityscheduling.com/schedule/abdd2b57/appointment/14752819/calendar/7377344"
}
```

Successful GET and POST responses have the same envelope:

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

Errors return `{ "error": "..." }`: invalid input is 400, unsupported selection is 422, concurrent requests are 429, upstream failures are 502/503, and the overall deadline is 504. Unsupported POST media types are 415. On Google Cloud, malformed JSON is rejected by the Functions Framework before the handler. The Vercel adapter returns JSON errors for malformed bodies (400) and bodies above 4 KiB (413). Failed scrapes do not return partial event lists.

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

## Deploy to Vercel

The repository includes a [Vercel-compatible Express export](https://vercel.com/docs/frameworks/backend/express) in `index.js` and a `vercel.json` configuration. Google Cloud's named `app` handler remains available, and `npm start` still runs the Functions Framework locally.

1. Commit and push the project changes to your Git repository.
2. In Vercel, choose **Add New > Project** and import that repository.
3. Set **Framework Preset** to **Express** and **Root Directory** to the directory containing `package.json`. Leave build and output overrides unset; there is no frontend compilation step.
4. Use **Node.js 22.x** (already specified in `package.json`) and keep **Fluid compute enabled**. No environment variables are required.
5. Click **Deploy**, open the generated root URL, and verify the JSON response contains `count` and `events`.

`vercel.json` sets a [180-second function duration](https://vercel.com/docs/functions/configuring-functions/duration) around the scraper's 150-second deadline. The Express preset supplies routing for `/` and `/scrape`; no custom rewrites, HTML assets, or `api/` directory are needed.

For CLI deployment, from the project root:

```sh
npx vercel@latest
```

Follow the login/project prompts to create a preview deployment. Once checked, deploy production with `npx vercel@latest --prod`. `.vercelignore` excludes local discovery files, dependencies, tests, CLI scripts and the handoff ZIP. `.vercel/` is excluded from Git and Google Cloud uploads.

The Vercel export and Google Functions Framework are covered by local HTTP integration tests. A hosted Vercel deployment has not been performed; the final smoke test is the deployment step above.

## Deploy from the Cloud Run function source editor

For the existing `get-rocket-ice-stick-puck2` service, use **Node.js 22** to match `package.json`, and set **Function entry point** to **`getRocketIce_StickPuck2`** (case-sensitive). `index.js` registers both that name and `app`, so the CLI instructions below remain valid. The service name and function entry point can differ; the entry point must match a registered handler, as described in [Google's function documentation](https://docs.cloud.google.com/run/docs/write-functions).

Include these files at the root of the deployed source:

```text
index.js
package.json
package-lock.json
scraper.js
validate.js
```

Replace the deployed `index.js` with the repository's updated version. It returns JSON from GET requests and has no HTML file reads or webpage route to comment out. No `public` folder is needed. `package.json` must include both `express` and `@google-cloud/functions-framework` as production dependencies. Google installs them during the build; do not upload `node_modules`.

Save the source and redeploy, then open the function's root URL to check the JSON response from `GET /`. `GET /scrape` and `POST /scrape` are also supported. The Functions Framework starts the HTTP listener; no manual `app.listen()` is needed.

If deployment reports that the container failed to listen on `PORT=8080`, open the failed revision's **Cloud Logging** link and read the first application startup error. A missing entry point, missing source file, or missing dependency can all stop the process before it listens. Fix that underlying error before changing timeouts. This repository is configured and tested with Node.js 22.

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

Open that URL and verify it returns JSON with `count` and `events` as the deployment smoke test. `.gcloudignore` excludes dependencies, local discovery artifacts, tests and CLI scripts from uploads; Google installs the locked production dependencies during the build.

The command creates a public MVP endpoint. Maximum instances and one job per instance bound concurrent work; they are not per-user rate limits or a spending cap. For a private deployment use IAM invocation controls and an authenticated access path. No hosted deployment has been performed from this workspace.

## Verification

`npm test` runs 25 offline tests using Node's built-in test runner. They cover URL validation and redirects, selected appointment scope, date boundaries, a UTC/local-date mismatch, year rollover, daylight saving, sorting/deduplication, hidden/missing/zero spaces, empty months, bounded retries, failures without partial results, response limits, cancellation, and HTTP routing/concurrency. Integration tests exercise the Vercel Express export and both Google entry points (`app` and `getRocketIce_StickPuck2`) over real local HTTP connections, including GET defaults, query parsing, repeated or invalid query URLs, JSON response headers, HEAD rejection without scraping, and POST body parsing. The tests run without HTML assets.

On October 16, 2026, a live local check started the Functions Framework with `FUNCTION_TARGET=getRocketIce_StickPuck2` on port 8080, without HTML assets. `GET /` returned HTTP 200 with `application/json` and 139 events from the default Rocket Ice schedule in about 17 seconds. Google Cloud redeployment remains unverified.

Historical live checks completed on October 7, 2026 with Node.js 22.23.2, before the browser interface was removed:

- Two consecutive complete scrapes succeeded; the UI run returned **220 events in about 20 seconds**.
- All five October 18 start times and remaining-space counts matched the rendered calendar. End times were checked against the published 60-minute duration.
- Browser validation, preview, the actual downloaded JSON file, and a 390px mobile layout were checked. The downloaded array matched the HTTP response exactly; no browser JavaScript errors occurred.
- `npm audit` reported **zero vulnerabilities** after a narrowly scoped `cloudevents` → `uuid@11.1.1` override. This CommonJS-compatible release fixes [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). The framework's CloudEvents UUID generation was checked after the override.
- Real Google Cloud deployment remains unverified; use the deployment smoke test above.

Availability counts are a snapshot and will change as people book. Offline tests do not contact the rink. For a fresh live check, run the CLI or open the function URL; avoid repeatedly scraping in a tight loop.

## Files

```text
index.js              Google HTTP handler and Vercel Express export
vercel.json           Express preset and function duration
.vercelignore         Files excluded from Vercel CLI uploads
scraper.js            Public availability requests and event normalization
validate.js           Schedule URL allowlist and selection parsing
scripts/scrape.js      Standalone CLI using the same scraper
test/                 Offline regression tests
package.json          Node.js 22, Express and Functions Framework dependencies
package-lock.json     Reproducible dependency versions
plan.md               Original implementation plan
```

Requests are sequential, with at most three attempts for transient failures, 20 seconds per request, a 150-second overall deadline, bounded response sizes and at most 30 appointment/calendar combinations. Very large schedules receive an error directing the user to a specific appointment link. HTTPS host/path checks are reapplied to every page redirect, API requests are sent only to the fixed Acuity origin, and external redirects are rejected.
