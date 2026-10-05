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
src/internal/api        read-only JSON API
```

### Storage

SQLite via `modernc.org/sqlite` (pure Go, so the image is `FROM scratch` with
CGO off). WAL mode lets the API read while the poller writes, and writes are
serialized with `BEGIN IMMEDIATE`. Tables: `products`, `variants` (latest
state), `events` (history, with `notified_at`). Schema is versioned with
`PRAGMA user_version`. Needs a single replica and a persistent volume.

### API

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | liveness; includes time of last completed poll |
| `GET /v1/variants?region=` | latest state of every variant |
| `GET /v1/events?region=&since=&limit=` | changes with `id > since`, oldest first |

`since` lets a client page forward by remembering the last event ID it saw.
There is no auth yet; the service is intended to be reachable only inside the
homelab. Auth arrives with the mobile apps.

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

Per-user subscriptions, device tokens, APNs/FCM, anti-scalper measures
(jitter, rate limits, device attestation), Live Activities, trend analysis,
and regions beyond the US. The event history already stores what trend
analysis would need. The March design covers those ideas and can be mined
when the apps start.

## Open questions

- Whether the EU storefronts share one inventory pool, before adding EU.
- Whether Ubiquiti tolerates this at app scale. A fleet of clients each
  polling would be unacceptable, so the server must stay the single poller.
