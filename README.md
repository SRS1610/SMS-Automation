# SMS Automation

A self-hosted dashboard for sending bulk SMS to customers in any country, through
the SMS gateway providers you already use.

- **Send SMS:** paste numbers or upload a CSV, personalise with `{{name}}`-style
  variables, see live character/segment counts and a phone preview, then send now
  or schedule.
- **Global by default:** every number is validated and normalised to E.164 for
  245 countries/territories, de-duplicated, and routed to a gateway by its
  destination country.
- **Settings → Gateways:** connect Twilio, Vonage, Plivo, Sinch, Telnyx,
  Infobip, ClickSend, Africa's Talking, any HTTP API, or a free simulated
  Sandbox. Credentials are encrypted at rest. Test the connection or send a test
  SMS from the card.
- **Reliable delivery:** per-gateway rate limits, automatic retries with
  back-off, fail-over to the next gateway, and delivery receipts via webhooks.
- **Campaigns:** live progress, per-recipient status, pause, resume, cancel,
  retry failed, and CSV export.
- **Compliance helpers:** an opt-out (suppression) list enforced on every send,
  and an optional opt-out footer such as "Reply STOP to opt out".

## Quick start

Requires **Node.js 22.13 or newer**. The database is Node's built-in SQLite, so
there is nothing else to install.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The API runs on port 3000, and Vite proxies to it.

Then:

1. Go to **Settings → Gateways → Add gateway**. Pick **Sandbox (simulated)** to try
   everything without sending real SMS, or connect your real provider.
2. Go to **Send SMS**, paste a few numbers, write a message, and send.
3. Watch delivery progress on the campaign page and the **Dashboard**.

### Production

```bash
npm run build
```

```bash
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

This serves the dashboard and API on one port (default 3000). Put it behind
HTTPS (nginx, Caddy, a load balancer...) and set `SECURE_COOKIES=true`.

## Configuration

Copy `.env.example` and set the variables in your environment (the app doesn't
load `.env` files itself; use your process manager, Docker, or `node --env-file`).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `ADMIN_PASSWORD` | unset | Password for the dashboard. **When unset, anyone who can reach the port can send SMS.** Always set it outside local development. |
| `APP_SECRET` | generated | Encrypts gateway credentials (AES-256-GCM) and signs session cookies. If unset, a random key is created once in `DATA_DIR/secret.key`. Changing it makes saved credentials unreadable. |
| `DATA_DIR` | `./data` | Holds `sms.db` (SQLite) and the generated secret. Back this directory up. |
| `SECURE_COOKIES` | `false` | Set to `true` when served over HTTPS. |
| `WEB_DIR` | `./dist/web` | Where the built dashboard is served from. |

Everything else is set in the dashboard under **Settings → General**: default
country for local-format numbers, default sender ID, opt-out footer, attempts
per message, and the public URL used for delivery receipts.

## Gateways

| Gateway | Credentials | Delivery receipts |
|---|---|---|
| Twilio | Account SID, auth token, optional Messaging Service SID | Automatic (sent per message) |
| Vonage (Nexmo) | API key, API secret | Automatic |
| Plivo | Auth ID, auth token, optional Powerpack UUID | Automatic |
| Sinch | Service plan ID, API token, region | Automatic |
| Telnyx | API key, optional messaging profile ID | Automatic |
| Infobip | Personal base URL, API key | Automatic |
| ClickSend | Username, API key | Not tracked: messages stay "Sent" |
| Africa's Talking | Username, API key, live/sandbox | Paste the webhook URL into the AT dashboard |
| Custom HTTP gateway | URL, method, body template, headers, response/receipt field mapping | Point your gateway's callback at the webhook URL |
| Sandbox (simulated) | Optional rejection/failure rates | Simulated |

The **Custom HTTP gateway** covers any other provider (regional aggregators,
Kannel, an Android SMS gateway, an internal service). The body template supports
`{{to}}`, `{{to_digits}}`, `{{from}}`, `{{text}}`, `{{callback_url}}` and
`{{unicode}}`, each escaped for where it appears (URL, JSON or form body).

### Routing and fail-over

For each recipient, candidate gateways are the enabled ones that cover its country:

1. Gateways limited to **specific countries** that include the destination come
   first, ahead of catch-all ("All countries") gateways.
2. Ties are broken by **priority** (lower first), then name.

The first candidate sends. If it rejects the message, or a temporary error
(timeout, throttling, 5xx) occurs, the message is retried on the next candidate,
with exponential back-off for temporary errors, up to "Attempts per message"
(or once per candidate, whichever is higher). A campaign can also be locked to
one gateway on the Send page.

Each gateway has a **messages-per-second** limit, enforced with a token bucket.
Set it to your account's throughput.

### Delivery receipts

Gateways report "delivered" or "failed" by calling
`https://<your-public-url>/webhooks/<gateway-id>/<secret-token>`. The exact URL is
shown on each gateway card. For gateways marked *Automatic*, the URL is sent with
every message once you set **Settings → General → Public URL**. It must be
reachable from the internet; during local development use a tunnel such as ngrok
or Cloudflare Tunnel.

Without receipts, messages stop at **Sent** (accepted by the gateway), and the
dashboard's delivery rate stays empty.

## SMS length and encoding

Messages are measured exactly as carriers bill them. GSM-7 text fits 160
characters, or 153 per part when split; characters such as `€ [ ] { }` count
double. Anything outside GSM-7 (emoji, curly quotes, non-Latin scripts) switches
the whole message to UCS-2, which fits 70 characters, or 67 per part. The
composer shows which characters caused the switch and can replace typographic
quotes and dashes with plain ones in one click. Personalised messages are
measured per recipient.

## Project layout

```
server/            Express API, dispatcher and gateway adapters
  providers/       One file per gateway + registry
  dispatcher.ts    Queue worker: routing, rate limits, retries, fail-over
  campaignStore.ts Campaigns, messages, receipts, dashboard stats
  providerStore.ts Gateway CRUD with encrypted credentials
shared/            Code used by both server and browser:
                   SMS segment maths, phone normalisation, templating, routing
web/src/           React dashboard (Dashboard, Send SMS, Campaigns, Settings)
tests/             Vitest unit and API tests
```

## API

All endpoints are under `/api` and need a session cookie when `ADMIN_PASSWORD`
is set (`POST /api/login` with `{ "password": "…" }`).

| Method & path | Purpose |
|---|---|
| `GET /api/overview` | Dashboard stats |
| `GET/POST /api/campaigns` | List / create (`{ name, body, sender?, providerId?, scheduledAt?, defaultCountry?, recipients: [{ phone, vars? }] }`) |
| `GET /api/campaigns/:id`, `/messages`, `/export.csv` | Campaign detail, per-recipient status, CSV |
| `POST /api/campaigns/:id/pause`, `resume`, `cancel`, `retry-failed` | Lifecycle |
| `GET /api/provider-types` | Supported gateways and their fields |
| `GET/POST /api/providers`, `PUT/PATCH/DELETE /api/providers/:id` | Manage gateways |
| `POST /api/providers/:id/test`, `/send-test` | Check credentials / send one SMS |
| `GET/PUT /api/settings` | General settings |
| `GET/POST /api/suppressions`, `DELETE /api/suppressions/:number` | Opt-out list |

## Development

```bash
npm test
```

```bash
npm run typecheck
```

Tests cover segment counting, phone normalisation, templating, routing, every
gateway adapter's request/response/webhook handling (with mocked HTTP), and the
API end to end: sending, receipts, fail-over, retries, rate limiting, opt-outs,
pause/resume/cancel and authentication.

## Notes and limits

- One server process sends everything. Messages that were mid-send during a
  crash or restart are re-queued on start-up, so a recipient may rarely receive a
  message twice.
- A campaign accepts up to 100,000 recipients and messages up to 1,600 characters.
- You are responsible for consent and local rules (TCPA in the US, GDPR/PECR in
  Europe, DLT registration in India, sender ID registration in many countries).
  Some countries reject alphanumeric sender IDs or require them to be registered
  with the gateway first.
