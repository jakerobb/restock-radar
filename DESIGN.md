# Restock Radar: Design

Restock Radar watches products on the UniFi store and pushes a notification
when stock or price changes. The server is a small Go service for a homelab;
mobile apps with native push come later.

This replaces the March 2026 design, which put ChangeDetection.io and a
headless browser in front of a webhook receiver.

## How it gets data

The store is a Next.js app. Alongside every page it serves the JSON the page
renders from, at `/_next/data/{buildId}/{region path}/...json`. We read that
directly instead of loading pages, so there is no browser and no HTML parsing.
Requests ask for gzip or deflate (`Accept-Encoding`), which shrinks the JSON about 9x.

- **buildId.** Changes whenever the store deploys. Scraped from the storefront
  HTML (`"buildId":"..."`) and cached. A 404 with a body other than
  `{"notFound":true}` means the buildId is stale: refetch it and retry once.
- **Product endpoint.** `/_next/data/{buildId}/us/en/products/{slug}.json`.
  `pageProps.currentProductId` picks the product out of `collection.products`.
  Each variant carries `status` (`Available`, `SoldOut`, `ComingSoon`, ...),
  `displayPrice`, `displayRegularPrice` (set when discounted), and
  `restockEtaAt`. Prices are in minor units.
- **Category endpoint.** `/_next/data/{buildId}/us/en/category/{id}.json`, where
  `id` is a leaf category (the one in `pageProps.category.currentCategory.id` of
  a product page; parent categories redirect home). `pageProps.subCategories[]`
  lists the whole family of sibling categories, each with `products[]` carrying
  the same variant fields as the product endpoint. It is unpaginated, so one
  request (~0.4-0.7 MB uncompressed) covers every product in the family.
- **Redirects.** Old slugs answer HTTP 200 with `pageProps.__N_REDIRECT`
  rather than a 3xx. We follow it, if it targets a product page, up to three hops.
- **Unknown slug.** 404 with `{"notFound":true}`.

This is an undocumented API. It can change or be blocked without notice, so
the design assumes failure is normal and loud (see Failure handling).

## Behaviour

- Every `poll_interval` (default 20m, +/- jitter) the poller refreshes the
  watch list, sequentially, with a short randomized delay between requests.
  Items whose category is known are grouped, and one category request covers
  every item in the group (and in sibling categories already covered). Items
  with no known category, or that their category page doesn't list, get a
  product request of their own. Products found only through category pages
  (`discovered`) are never requested individually.
- **Discovery.** Every product on a category page that we haven't seen is added
  to the watch list (`source = discovered`) and baselined. If the category was
  already ingested (the `categories` table), the product is new to the store and
  a `new` event is queued, so it is announced like any other change; otherwise
  it is adopted silently, so the first look at a category doesn't announce the
  catalogue. Discovered products don't count toward `max_items`.
- **Variant names.** A variant's title is built from the product's `options`
  and the variant's `optionValueIds` ("White / 0.2 m / 10-Pack"), because the
  store's own variant `title` exists only on the product endpoint and the
  category endpoint would blank it. Where the ids resolve to nothing, the
  store's title is used.
- **Product details.** Only the product endpoint carries `category.breadcrumbs`,
  whose titles ("UniFi Patch Cables") are the store's own grouping of products
  within a collection; we store the one containing each product as its group,
  and `shortTitle` as its short title. Products found only on category pages
  have neither, so after the regular requests each cycle fetches up to 5
  products (listed ones first, then oldest) that have never come from the
  product endpoint, then those that last did over a week ago. A failure skips
  that product until restart. The UI merges products only when they share a
  collection and a group.
- **Technical specifications.** The product endpoint also carries the product's
  full specification (`technicalSpecification`: sections of entries, each a
  text value, a yes/no flag, or a group heading with entries under it). It is
  the same data as the tech specs site, with the same feature ids and values,
  so we read it here and not from there. Category pages carry only a six-entry
  grid summary, which is never taken for the specification. Entries the store
  lists for the category but leaves blank (a flag of `Empty`) are dropped, with
  any group left with nothing under it; malformed entries are dropped and
  logged, not treated as a failed fetch, since stock and price matter more.
  The values are display text ("5.8 dBi", "16 (8 PoE+; 8 PoE++)\n(1G/100M/10M)"),
  stored as they come so that anything derived from them (ports, radios,
  numeric metrics for searching and sorting) can be rebuilt from the stored copy
  without fetching again. A response without a specification leaves the stored
  one alone; one with an empty specification clears it.
- **Tech specs links.** Each product card links to its page on
  `techspecs.ui.com/unifi/<category>/<slug>`. The slug is the store's. The
  category is the store's category id mapped by prefix to one of the site's
  seven top-level categories; the site doesn't check that it's the product's
  own, only that it exists, and redirects unknown slugs to its home page. So a
  `HEAD` request that isn't redirected is how we know a page exists. Each cycle
  checks up to 5 watched products with a known category that have never been
  checked, then those last checked more than a week ago, stalest first, and
  stores the URL (or none) with the check time. The link is shown only when a
  check found a page. A failed check skips that product until restart, and a
  429/403/503 ends the cycle's checks.
- Each observation is applied to SQLite in one transaction. A variant seen
  for the first time sets a baseline silently. After that, a change in
  `status` yields a `status` event, and a change in price, regular price, or
  surcharges yields a `price` event. Surcharges (memory, tariffs, ...) are the
  store's add-ons to the base price: events record the price including them and
  the surcharge types before and after, and notifications say which moved and
  whether a type was added or removed. The store gives only the total, so a
  surcharge's own amount isn't known when a product has several types. Values
  not yet known (rows from before surcharges were tracked) never count as a change.
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
src/internal/specs      derives ports, radios, PoE budgets and numbers from a specification; applies overrides
src/internal/api        JSON API (state, history, add product, specs, overrides)
src/internal/webui      embedded static web UI
ui/                     React + TypeScript source of the web UI
```

### Storage

SQLite via `modernc.org/sqlite` (pure Go, so the image is `FROM scratch` with
CGO off). WAL mode lets the API read while the poller writes, and writes are
serialized with `BEGIN IMMEDIATE`. Tables: `products`, `variants` (latest
state), `events` (history, with `notified_at`). Schema is versioned with
`PRAGMA user_version`. Needs a single replica and a persistent volume.

`variant_numbers` gives every variant a permanent small integer (`num`, served on each variant by `/v1/products`). It is `AUTOINCREMENT`, so a number is never reused, and it identifies the region, product and variant at once. Shared build-plan links are made of these numbers.

`product_specs` holds each product's specification, one row per entry in the
store's order: its section (id, label, and type, `Standard` or the grid's
`Overview`), the feature's id and label, its parent group's feature id, the kind
(`text`, `flag` with value `true`/`false`, or `group`), the value, and the
store's footnote. A feature id is unique within a section but repeats across
them (the grid summary echoes features shown elsewhere), so rows are keyed by
position. `products.specs_hash` identifies the stored rows, so an unchanged
specification isn't rewritten, and `products.specs_fetched_at` is when the
product endpoint last supplied the product; it decides when the product is
next fetched.

### Derived specifications and overrides

The stored specification is display text ("16 (8 PoE+; 8 PoE++)\n(1G/100M/10M)"),
so searching and sorting by it needs numbers. `internal/specs` derives them, as
pure functions of a product's specification, and the store keeps the result in
tables that can be queried:

| Table | One row per | Answers |
|-------|-------------|---------|
| `product_ports` | group of identical ports (split by PoE class) | "a 10GbE PoE+++ port": media, count, speeds, PoE class, direction (`out`/`in`), watts per port, combo, role |
| `product_poe_budget` | PoE budget figure | the device's budgets; `selected` marks the one used for sorting |
| `product_radios` | radio band | "a 6 GHz radio"; antenna gain, TX power, streams, max rate; `tech` separates WiFi from 60 GHz, Bluetooth and SuperLink |
| `product_metrics` | number | `poe_budget_w`, `power_draw_max_w`, `power_draw_excl_poe_w`, `switching_capacity_gbps`, `nonblocking_throughput_gbps`, `forwarding_rate_mpps`, `ids_ips_throughput_mbps`, `wifi_generation`, `nvr_cameras_hd`/`_2k`/`_4k` (how many cameras of each class an NVR manages; the first configuration when two are given), `camera_megapixels` (one sensor's resolution, from the pixel dimensions where given, else the headline); with the text each came from |
| `product_power` | way of being powered | "Power Method": `poe` (with the lowest class that powers it), `passive_poe`, `ac`, `dc`, `usb`, `battery`, `rps` (a redundant-supply input) or `other` (powered by an accessory or another device); one row per distinct kind, with the line it came from. No rows means the specification doesn't say |
| `product_derived` | product | rack mount and U height, size in mm, which facts were found, issues, what overrides changed |

Things worth knowing about how it reads the text, each found by testing against
the whole real catalogue:

- Only the standard sections are read; the grid overview is a summary of them.
  Text is normalised first (non-breaking spaces and hyphens, a fullwidth `<`,
  `<a>` links), and the stored text is never altered.
- **PoE budget** is the figure after the colon on each line: `210W AC adapter
  input: 196W` is a 196W budget, and the largest number in the text is wrong for
  some products. A product that ships an external power supply gets the scenario
  for that supply (USW-Ultra-60W: 52W, USW-Ultra-210W: 202W); any other gets its
  best case, and every scenario is kept.
- **PoE direction.** A port listed `PoE+++` on a device whose `Max. PoE Output`
  is PoE++ is the one the device is powered through (the text sometimes says
  "input" and sometimes doesn't), so it is stored as an input and never matches a
  search for PoE+++ ports that supply power. Watts per port come from the
  device's own table, since PoE+ is 30W on some and 32W on others.
- **Radios** are the union of the bands named under antenna gain, TX power, MIMO
  and data rate, which don't all list every band. WiFi generation says nothing
  about 6 GHz: several WiFi 7 access points have no 6 GHz radio. A figure that
  spans several antennas keeps the largest, flagged `multi`; EIRP figures are not
  conducted power.
- **Size.** The store lists a device's three dimensions in no consistent order,
  so they are stored sorted (`min`, `mid`, `max`). Width, depth and height are
  set only where they can be told apart: a rack-mount device of known height,
  where the height is that of its units and the width is a 19-inch rack's. A
  size that is given for several parts or configurations is used only if one is
  the bare device ("Without mount") and otherwise left unread. A fit check for a
  smaller rack (10-inch) is a query against these numbers, not stored data.
- "No ports" or "no 6 GHz radio" is only a claim about a product whose ports or
  radios were found (`known_*` on `product_derived`); otherwise it is unknown.
- What it cannot read goes to `issues`, with the label and value, and the rest of
  the product is still derived. A panic in a parser is recovered and recorded the
  same way; it never stops a product being tracked.

A product is derived in the same transaction that stores a changed
specification, and again when its overrides change. `product_derived.version`
records which derivation made each row; starting up with a newer one derives the
stored specifications again, with no fetching.

**Overrides** are the user's corrections: a value replaced (an IDS/IPS throughput
the store rates at 5 Gbps but a teardown shows exceeding 8), an entry the store
doesn't publish added, or a published entry hidden. They live in `spec_overrides`,
apart from the published rows, so the store republishing a product doesn't lose
them. An override is found by its product slug and its target (section, group,
label), not by the store's ids, and is applied before anything is derived, so a
value is read by the same parsers whether it was published or typed. The
published value stays visible beside an overridden one in `/v1/products/.../specs`
(`published_value` on the entry; `overridden` on the derived facts). Each override
records the value the store published when it was made; if the store later
publishes something else, the override still applies and is reported `stale`, and
saving it again clears that. An override whose target has disappeared is
`orphan` and does nothing. Each carries a source URL and a reason.

### Watch list and web UI

The watch list is the `items` table, not the config. Each row has a `source`:
`config` rows are reconciled with the config's `items` at startup (added, or
removed if no longer listed) and `ui` rows are added through the web UI and
never touched by the reconcile; `discovered` rows come from category pages and
are likewise left alone. Once a poll resolves an item, its row records
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
`Sec-Fetch-Site: cross-site`. Who may change things is decided in
`internal/auth` (see Access control below).

### API

| Endpoint | Purpose |
|----------|---------|
| `GET /` | web UI (static files embedded in the binary) |
| `GET /v1/products` | products with variants grouped, last sync time, pending items |
| `POST /v1/items` | add a product: `{"item": slug-or-URL, "region": optional}` |
| `GET /v1/status` | counts for the `/status` page: products, categories, specs and techspecs URL coverage, stock, activity |
| `GET /health` | liveness; includes time of last completed poll |
| `GET /v1/history?days=` | each variant's status and price timeline over the last `days` (default 30, max 365), rebuilt from `events` |
| `GET /v1/variants?region=` | latest state of every variant |
| `GET /v1/events?region=&since=&limit=` | changes with `id > since`, oldest first |
| `GET /v1/products/{region}/{slug}/specs` | a product's effective specification (origin of each entry, published value beside an overridden one), its overrides with their status, and what is derived from it |
| `POST /v1/products/{region}/{slug}/refresh` | fetch one tracked product from the store now, instead of waiting for the next read, and record what it finds as a poll would: price and stock, group, specification (re-derived if it changed). Returns `{region, slug, title, variants, spec_entries, specs_changed, events}`. `404` for a product we don't track, `400` if the store no longer has it or has given the slug to another product, `502` if the store can't be reached. Notifications for any change it finds go out with the next poll. |
| `GET /v1/derived?region=` | what is derived for every product: ports, PoE budgets, radios, numbers, rack, size |
| `GET /v1/me` | who the service takes the caller to be and what they may do: `{mode, authenticated, open, user, name, email, roles, permissions}`; never cached |
| `GET /v1/overrides/history?region=&slug=&limit=` | the append-only record of changes to overrides, newest first: who, when, and the override before and after. Needs `overrides:write` |
| `GET /v1/overrides?region=&slug=` | overrides, each with its status (`overrides`, `hides`, `adds`, `orphan`), `stale`, and the value published now |
| `PUT /v1/overrides` | create or replace an override: `{"slug", "region" (optional), "action": "set"\|"hide", "section", "group" (optional), "label", "kind" (optional), "value", "note", "source_url", "reason"}` |
| `DELETE /v1/overrides/{id}` | remove an override |

`POST /v1/products/{region}/{slug}/refresh` has no body, so its only cross-site guard is the `Origin`/`Sec-Fetch-Site` check; it is limited to 10 a minute, since each one is a request to the live store. A refresh doesn't count toward the consecutive-failure alert: the caller sees the error.

`PUT` and `DELETE /v1/overrides` take the same cross-site checks as `POST
/v1/items` (a JSON content type for `PUT`, no foreign `Origin` or `Sec-Fetch-Site:
cross-site`), refuse unknown fields, require an `http(s)` source URL, bound the
length of every field, and are limited to 30 changes a minute. A target that
isn't a published entry of the product, or a hide of something that isn't there,
is refused with a message rather than stored.

`since` lets a client page forward by remembering the last event ID it saw.
Reading needs no permission. The routes that change something are wrapped by
`require(permission, handler)`; see Access control.

### Access control

Who is asking, and what they may do, is separate from what each route does.
`auth.Authenticator` turns a request into a `Principal` (user, roles); roles
hold `Permission`s (`overrides:write`, `watchlist:write`, `products:refresh`);
`Server.require(perm, handler)` wraps every route that changes something (and
the override history, which names people), answering 401 to somebody not
signed in and 403 to somebody who is but may not. The handler reads the
principal from the request context, never from headers. Anything that
authenticates differently (accounts of the service's own, say) is another
`Authenticator`; nothing else changes.

Two modes. `open` treats everyone as an administrator, for a deployment only its
owner reaches; `public: true` is a config error there. `proxy` believes
identity headers (Authelia's by default) only when the request's own connection
(`RemoteAddr`, never `X-Forwarded-For`) comes from a `trusted_proxies` network,
and maps proxy groups to roles. Header values with control characters or odd
lengths are refused rather than recorded. If the config can't be made sense of
at run time, `auth.New` returns an authenticator that treats everybody as
nobody: it fails closed, not open.

Overrides record `created_by` and `updated_by`, and every create, update and
delete appends a row to `spec_override_history` (before and after as JSON; no
foreign key, so a deleted override is still on record). A save that changes
nothing adds no row. Anyone without `overrides:write` gets overrides without the
names.

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
when the apps start. Per-user build plans and saved-search alerts are planned
separately in [docs/ui-roadmap.md](docs/ui-roadmap.md), along with the UI,
product finder and access-control design.

## Open questions

- Whether the EU storefronts share one inventory pool, before adding EU.
- Whether Ubiquiti tolerates this at app scale. A fleet of clients each
  polling would be unacceptable, so the server must stay the single poller.
