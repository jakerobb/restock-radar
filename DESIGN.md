# Restock Radar: Design

Restock Radar watches products on the UniFi store and pushes a notification
when stock or price changes. The server is a small Go service for a homelab;
mobile apps with native push come later.

This replaces the March 2026 design, which put ChangeDetection.io and a
headless browser in front of a webhook receiver.

## How it gets data

The store is a Next.js app. Alongside every page it serves the JSON the page
renders from, at `/_next/data/{buildId}/{region path}/...json`. We read that
directly instead of loading pages, so there is no browser, no HTML parsing, and
one small request per product.

- **buildId.** Changes whenever the store deploys. Scraped from the storefront
  HTML (`"buildId":"..."`) and cached. A 404 with a body other than
  `{"notFound":true}` means the buildId is stale: refetch it and retry once.
- **Product endpoint.** `/_next/data/{buildId}/us/en/products/{slug}.json`.
  `pageProps.currentProductId` picks the product out of `collection.products`.
  Each variant carries `status` (`Available`, `SoldOut`, `ComingSoon`, ...),
  `displayPrice`, `displayRegularPrice` (set when discounted), and
  `restockEtaAt`. Prices are in minor units.
- **Redirects.** Old slugs answer HTTP 200 with `pageProps.__N_REDIRECT`
  rather than a 3xx. We follow it, if it targets a product page, up to three hops.
- **Unknown slug.** 404 with `{"notFound":true}`.

This is an undocumented API. It can change or be blocked without notice, so
the design assumes failure is normal and loud (see Failure handling).

## Behaviour

- Every `poll_interval` (default 20m, +/- jitter) the poller walks the watch
  list sequentially with a short randomized delay between requests.
- Each observation is applied to SQLite in one transaction. A variant seen
  for the first time sets a baseline silently. After that, a change in
  `status` yields a `status` event, and a change in price or regular price
  yields a `price` event.
- Events are the system's source of truth. Notification is a separate step:
  an event is marked `notified_at` only after a successful send, and unsent
  events are retried at the start of each cycle and after each product.
- "Only notify on a price drop" and similar filters are per-user and belong
  in the client apps. The server reports every change, with old and new values.

## Identity and regions

- Items are identified by **product slug** and, once seen, by the store's
  product and variant UUIDs. The database keys on `(region, uuid)`, so a slug
  rename doesn't create a new product.
- A product can have several variants (colors, regional SKUs). State and
  events are per variant.
- **Region is part of every key and every API call.** Only the US store
  (`store.ui.com/us/en`) is configured today, but regions are config
  (`id`, `base_url`, `path`), stock does not sync across them, and an
  empty `?region=` means all.

## Components

```
src/cmd                 entry point: config, DB, poller goroutine, HTTP server
src/internal/config     YAML config + ${ENV} interpolation + validation
src/internal/unistore   store client: buildId, product fetch, redirects
src/internal/store      SQLite: products, variants, events; migrations
src/internal/poller     poll loop, change recording, delivery, failure alerts
src/internal/notify     Notifier interface, message rendering, ntfy sender
src/internal/metrics    Prometheus counters and rendering
src/internal/dbcopy     periodic database backups (VACUUM INTO)
src/internal/api        JSON API (state, history, add product)
src/internal/webui      embedded static web UI
ui/                     React + TypeScript source of the web UI
```

### Storage

SQLite via `modernc.org/sqlite` (pure Go, so the image is `FROM scratch` with
CGO off). WAL mode lets the API read while the poller writes, and writes are
serialized with `BEGIN IMMEDIATE`. Tables: `products`, `variants` (latest
state), `events` (history, with `notified_at`). Schema is versioned with
`PRAGMA user_version`. Needs a single replica and a persistent volume.

### Watch list and web UI

The watch list is the `items` table, not the config. Each row has a `source`:
`config` rows are reconciled with the config's `items` at startup (added, or
removed if no longer listed) and `ui` rows are added through the web UI and
never touched by the reconcile. Once a poll resolves an item, its row records
the product ID, which is how the UI tells "tracked, waiting for first check"
from "tracked and seen".

The UI is a React + TypeScript single-page app (Vite, Tailwind CSS v4, React
Query) in `ui/`. It is compiled to static files and embedded in the Go binary
with `go:embed`, so deployment is still one `FROM scratch` image: the Dockerfile
builds the UI in a Node stage and copies the result into the Go build. Next.js
was considered and passed over; the app has no server rendering or routing
needs, so Vite gives the same precompiled output with far less framework.

Adding a product goes through `Poller.Add`: parse the slug or URL against the
configured regions, fetch it from the store, refuse if its product ID is already
known, otherwise add the item under the store's canonical slug and record a
silent baseline. `POST /v1/items` requires a JSON content type, which a
cross-site form can't send, and refuses a foreign `Origin` or
`Sec-Fetch-Site: cross-site`. There is no authentication in the app; the
homelab puts Authelia in front.

### API

| Endpoint | Purpose |
|----------|---------|
| `GET /` | web UI (static files embedded in the binary) |
| `GET /v1/products` | products with variants grouped, last sync time, pending items |
| `POST /v1/items` | add a product: `{"item": slug-or-URL, "region": optional}` |
| `GET /health` | liveness; includes time of last completed poll |
| `GET /v1/history?days=` | each variant's status and price timeline over the last `days` (default 30, max 365), rebuilt from `events` |
| `GET /v1/variants?region=` | latest state of every variant |
| `GET /v1/events?region=&since=&limit=` | changes with `id > since`, oldest first |

`since` lets a client page forward by remembering the last event ID it saw.
There is no auth yet; the service is intended to be reachable only inside the
homelab. Auth arrives with the mobile apps.

### Metrics

`GET /metrics` renders counters kept by `internal/metrics` (updated by the
poller) plus a few gauges read from SQLite at scrape time. The one that matters
most is `restock_radar_last_success_timestamp_seconds`: it moves only on a
successful product fetch and starts at process start, so "no successful fetch
for an hour" covers a blocked store, an outage, and a hung poller alike
(`/health` can't, since it only says the process is up). `fetches_total` by
result tells those causes apart.

### Notification failures

Delivery is in order and retried: an event is marked delivered only after ntfy
accepts it. A transient failure (network error, 5xx, 429, 408) stops the pass
and retries on the next one, so nothing is lost across an ntfy outage. A
permanent rejection (any other 4xx) can never succeed, and retrying it would
hold up every event behind it, so the event is marked `failed_at`, counted as
`dropped`, and skipped. Message headers are built from store-supplied titles,
so control characters are stripped and the length capped before sending.

### Backups

`internal/dbcopy` copies the database with `VACUUM INTO` into `backup_dir`
every `backup_interval`, keeping the newest `backup_keep` copies. It exists
because products added in the UI have no other home: config items are in git,
but UI-added ones live only in the database. Backups are anchored on the
newest file's age, not process start, so crash-looping doesn't churn them.

### Limits and hardening

The only endpoint that makes the server call out on demand is `POST /v1/items`,
so it is rate limited (10 per minute) and bounded by `max_items` and a 75s
timeout. The HTTP server sets read, write and idle timeouts and a header size
cap. Every response carries a strict Content-Security-Policy (same-origin
only, no inline script or style, no framing) plus `nosniff`, `no-referrer` and
`X-Frame-Options: DENY`; API and metrics responses are `no-store`.

### Notifications

`notify.Notifier` takes a delivery-agnostic `Message` (title, body, click URL,
priority, tags). ntfy is the only implementation. APNs and FCM would be
additional implementations. The click URL is always the product page, never
a cart link.

## Failure handling

- **Blocked or rate limited** (403, 429, 503): abandon the rest of the cycle,
  double the wait (max 8x), reset after a clean cycle.
- **Per-item failures** (not found, schema drift, network): after
  `failure_alert_after` consecutive failures for one item, send one ntfy
  alert; send one more when it recovers.
- **ntfy down:** events stay pending and are retried.
- **Restart:** all state is in SQLite. In-memory failure counters reset, which
  can only cause a repeat alert, not a missed one.

## Out of scope for now

Removing products from the UI, per-user subscriptions, device tokens, APNs/FCM, anti-scalper measures
(jitter, rate limits, device attestation), Live Activities, trend analysis,
and regions beyond the US. The event history already stores what trend
analysis would need. The March design covers those ideas and can be mined
when the apps start.

## Open questions

- Whether the EU storefronts share one inventory pool, before adding EU.
- Whether Ubiquiti tolerates this at app scale. A fleet of clients each
  polling would be unacceptable, so the server must stay the single poller.
