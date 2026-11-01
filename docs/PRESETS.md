# Website and presets hub (kindlingspark.app)

kindlingspark.app is one Cloudflare Worker with static assets:

| Path | What | Source |
|---|---|---|
| `/` | landing page | `site/index.html`, `site/site.css`, `site/screenshots/` |
| `/guide/` | user guide (same file the apps show under **Help**) | `src/guide/` |
| `/presets/` | presets hub: browse, preset detail, share, finish sign-in | `site/presets/` |
| `/api/*` | presets API | `worker/` |

`tools/build-site.js` assembles `site-dist/`. **The web app is not published** (the build fails if `site-dist/app/` appears): people install the desktop or Android app. Old `/app/…` links redirect (`site/_redirects`). Developers still run the app in a browser from source with `npm run serve`.

`worker/index.js` runs only for `/api/*` (`run_worker_first` in `wrangler.jsonc`), redirects `www.` to the apex domain, and runs a daily cleanup from a cron trigger. Everything else is served straight from the static assets, with headers from `site/_headers` (a strict Content-Security-Policy on `/presets/*`).

## Presets hub

People share presets made with KindlingControl. Anyone can browse and download; sharing needs an email sign-in.

- **Download:** `GET /api/presets/:id/download` returns the preset as an Ignitron-compatible `.json` file, the same format the app's Presets tab exports and imports (**Import JSON…**). It has `Access-Control-Allow-Origin: *`, so the apps can fetch shared presets directly later.
- **Upload:** the share page reads the exported file in the browser and posts it as JSON. The Worker validates and **re-serialises** it (`worker/preset.js`): exactly 7 blocks, effect ids matching `[A-Za-z0-9 ._+()-]`, finite parameters, a sane BPM, cleaned text. Nothing from the upload is stored verbatim. Parameters keep their exact float values.
- **Licence:** uploaders confirm they made the preset and dedicate it to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Uploads without that confirmation are refused.
- **Moderation:** anyone can report a preset (one report per person per preset; signed-out reporters are identified by a salted hash of their IP). After **3** reports it's hidden from the list, the detail page and downloads, but stays visible to its owner and to moderators. Moderators are the addresses in the `ADMIN_EMAILS` secret: they see hidden presets on the share page, and can restore or delete any preset. Owners can delete their own.

### Sign-in (email magic link)

1. `POST /api/auth/request {email}` creates a one-time token (15 minutes) and emails a link to `/presets/signin.html#token=…`.
2. The token is in the URL **fragment**, so mail scanners that pre-fetch links never send it to the server. The page clears it from the address bar, and the person presses **Finish signing in**, which `POST`s it to `/api/auth/verify`.
3. That sets an `HttpOnly; Secure; SameSite=Lax` session cookie (30 days). Tokens and session ids are stored only as SHA-256 hashes.

The request endpoint gives the same answer for new and existing addresses, and is rate-limited (5 per address and 10 per IP per hour). Uploads are limited to 20 per person per day, and reports to 20 per hour.

**Cross-site protection:** every write must be `Content-Type: application/json`, which browsers can't send cross-site without a CORS preflight that the API never approves. A request with an `Origin` other than `SITE_ORIGIN` is refused.

### Email

`worker/mail.js` uses the first one that's configured:

1. **Cloudflare Email Service:** a `send_email` binding named `EMAIL` (commented out in `wrangler.jsonc` until the domain is onboarded). The sender `MAIL_FROM` must be on the onboarded domain. **(unverified)** The call (`env.EMAIL.send({ to: [{ email }], from: { email, name }, subject, text, html })`) follows Cloudflare's published examples, but it hasn't been run against a live account yet. Test it after onboarding.
2. **Resend:** set the secret `RESEND_API_KEY`.
3. **Development:** `DEV_SHOW_LINKS=1` returns the link to the page instead of sending it. `tools/serve-site.js` sets this. Never set it in production.

With none configured, sign-in answers 503 and says email isn't set up.

### Data and privacy

| Table | Holds |
|---|---|
| `users` | email (only for sign-in links, never shown), display name, banned flag |
| `login_tokens`, `sessions` | hashes and expiry times; cleaned up daily |
| `presets` | the normalised preset, name, description, amp model, chain summary, download count, hidden flag |
| `reports` | preset id, reporter key (user id or hashed IP), reason |
| `rate_events` | rate-limit keys and times; cleaned up after 2 days |

Public API responses carry the display name, never the email. Schema: `migrations/0001_presets_hub.sql`.

## API

| Method | Path | Who | |
|---|---|---|---|
| GET | `/api/presets?q=&amp=&sort=new\|popular&page=` | anyone | 24 per page, `hasMore` |
| GET | `/api/presets/:id` | anyone | hidden ones: owner and moderators only |
| GET | `/api/presets/:id/download` | anyone | counts a download |
| POST | `/api/presets` `{preset, description, license: true}` | signed in | returns `{id}` |
| DELETE | `/api/presets/:id` | owner, moderator | |
| POST | `/api/presets/:id/report` `{reason}` | anyone | |
| POST | `/api/presets/:id/restore` | moderator | un-hide and clear reports |
| GET | `/api/admin/hidden` | moderator | hidden presets with report counts |
| POST | `/api/auth/request` `{email}` · `/api/auth/verify` `{token}` · `/api/auth/logout` | | |
| GET / PATCH | `/api/me` `{displayName}` · GET `/api/me/presets` | signed in | |

## Running it locally

```sh
npm run site:dev     # build site-dist/, then serve site + API on http://localhost:8788
```

`tools/serve-site.js` runs the real Worker code against an in-memory SQLite database (`tools/d1-sqlite.js`, Node 22's `node:sqlite`). Sign-in links appear on the page. The moderator is `admin@localhost.test` (override with `ADMIN_EMAILS=…`). The data disappears when it stops.

`test/presets-hub.test.js` covers the API the same way. For a closer match to Cloudflare, `npx wrangler dev` runs the Worker with a local D1 database (`npx wrangler d1 migrations apply kindling-presets --local` first).

## Setting up Cloudflare (once)

1. **Domain:** add `kindlingspark.app` to your Cloudflare account as a zone. `wrangler deploy` then attaches `kindlingspark.app` and `www.kindlingspark.app` as custom domains (`routes` in `wrangler.jsonc`).
2. **Database:** `npx wrangler d1 create kindling-presets`, and paste the printed `database_id` into `wrangler.jsonc`.
3. **Email:** onboard `kindlingspark.app` to Cloudflare Email Service, then uncomment the `send_email` binding. Alternatively, `npx wrangler secret put RESEND_API_KEY`.
4. **Secrets:** `npx wrangler secret put ADMIN_EMAILS` (moderators, comma-separated) and `npx wrangler secret put IP_HASH_SALT` (any long random string).
5. **CI:** add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs Workers Scripts: Edit, D1: Edit and, for the custom domain, Workers Routes: Edit on the zone.

After that, `.github/workflows/site.yml` deploys on every push to `main` that touches the website, the Worker, the guide or the protocol library. It runs the tests, builds `site-dist/`, applies D1 migrations (`wrangler d1 migrations apply --remote`), then runs `wrangler deploy`. `npm run deploy` does the same from your machine. Without the secrets, the workflow builds and tests, and skips the deploy.

Schema changes go in a new numbered file in `migrations/`. Never edit a migration that has already been applied.
