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
- **Regions.** Category ids are the same in every region, but each sells a
  different range (Japan has a handful of products in a category the US has 37 in).
  Each cycle, every region gets a group for every category any region's products
  are in, and a region with no page for one (the store redirects it home, which
  the client reports as not found) is left alone for a day. Products found this
  way are discovered like any other: silent the first time a region's category
  is read, announced after that. A region's `poll_every` rolls it: with
  `poll_interval` p and `poll_every` e, each cycle reads the `ceil(n*p/e)`
  groups (and category-less products) whose last read is oldest, never-read
  first. A page's whole family counts as read, so a family is read once however
  many of its categories are due. The read times are in memory only.
- **Variant names.** A variant's title is built from the product's `options`
  and the variant's `optionValueIds` ("White / 0.2 m / 10-Pack"), because the
  store's own variant `title` exists only on the product endpoint and the
  category endpoint would blank it. An option with a single value ("Color:
  White" on a cabinet sold only in white) is left out, as it tells variants
  nothing apart. Where the ids resolve to nothing, the store's title is used.
  When products merge into one card, each variant is named for its product's
  short title less the group's shared prefix; where that leaves two variants
  with the same name (the 12U cabinets all share "12U Rack Cabinet"), the full
  titles ("450 mm, Glass Door") name them instead, and a SKU in parentheses
  covers what is still the same.
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
- **Region is part of every key and every API call.** Eight storefronts
  answer with product data and are built in (`us`, `ca`, `eu`, `uk`, `jp`, `br`,
  `tw`, `sg`; each on its own host, with the store's default language in the
  path, as in `jp/ja`). The store lists six more (`in`, `me`, `za`, `cn`, `mx`,
  `ph`) that only redirect, so they aren't built in. Regions are config
  (`id`, `base_url`, `path`), stock does not sync across them (the same product
  can be in stock in one and coming soon in another), and an empty `?region=`
  means all.
- **Money.** Amounts are minor units, except that the store sends yen in whole
  yen; `minorUnits` (Go) and `minorPerUnit` (UI) know that.

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

`variant_numbers` gives every variant a permanent small integer (`num`, served on each variant by `/v1/products`). It is `AUTOINCREMENT`, so a number is never reused, and it identifies the region, product and variant at once. Shared build-plan links are made of these numbers, after the plan's name (UTF-8, at most 50 characters, behind a number 2^31 plus its length in bytes).

Some switches state several PoE budgets, one for each way they can be powered (`poe_budget`: "PoE+ input" 16 W, "210W AC adapter input" 196 W). The plan asks which, where a PoE or adapter input is on offer and no adapter is in the box (`lib/powering.ts`; the Ultra 60W and 210W, which are separate products and not variants, have theirs in the box and need no choice). The choice is the scenario's name by a 16-bit code (a hash, so a share link needn't carry the derived data), kept by line key in the plan's `powering` (in `restock-radar.plans`) and in the slug as an entry numbered 2^29 plus the variant's, with the code where a quantity would be. An adapter the store sells separately (`ADAPTER_PRODUCTS`, the 210 W one) is added to the plan when it is chosen, and a `power-adapter` check warns when the plan has fewer than one for each switch that runs on it; adapters sold only with a model (the 60 W ones) aren't offered. The finders take a switch nobody has chosen the power of to run on its best input. All of a product's PoE inputs are one option, "PoE", since the class is where the switch is plugged in and not something to choose: its budget is that of the best input the port it is placed on can supply (a switch taking PoE+ and PoE++ has the PoE++ budget on a PoE++ port, the PoE+ one on a PoE+ port), the allocator giving it the best port left and settling the budget with the load. Products of one collection that come with an adapter in the box (the Ultra 60W and 210W) are options too, by changing the product (`withSiblings`). A switch set to PoE is a PoE-powered device like an access point: it needs a port of that class and draws what it uses itself (`power_draw_excl_poe_w`) plus the load of the devices placed on it, which the allocator settles in a few rounds because it depends on where the switch goes; it can't be placed on its own ports, nor two switches on each other's. A switch on an adapter, or unchosen, needs nothing upstream.

A variant the store stops listing for a product (it renames one, which gives it a new id, so the old row would otherwise sit there with a stale price) is marked `delisted_at` when the product is next observed, since every observation carries all of a product's variants. It is kept, for its history and so that an old plan link naming its number still resolves, but `/v1/products` leaves it out of `variants` and gives its number and SKU under `retired`; it isn't counted in the status figures. If the store lists it again the mark is cleared. The time it was missing, from when it was last seen until it came back, is kept in `variant_gaps`, and `/v1/history` shows it as a point with no status and no price, so the chart leaves it blank (white, "Not listed or not tracked" in its key) rather than holding the old state across it. A variant that never comes back needs no gap: its timeline already ends at its last check. Past relists weren't recorded, so they still read as unbroken.

Category pages also give each product its `linkedProducts`: other products the store sells with it on its page, as a choice (a Cloud Gateway's 1 TB and 2 TB SSDs, a UPS's PDU Pro; the store's `?linked-variant=` link preselects one). The store's data lists more of them than its page offers (the UPS 2U Pro and the Cloud Gateway Max list the same PDU and SSDs), the choice being a table in the storefront's own code, so `offeredLinks` repeats that table and only those pairs are kept (the UPS 2U gets the PDU Pro, a Cloud Gateway Fiber or Max NS the 1 and 2 TB SSDs); a pair the store adds later needs adding there. They are products with a variant of their own, not variants of the product, and have no page of their own that we can read, so each is recorded as a product from what the category page says (named by its SKU, with price and stock, and events for changes) but isn't made an item: it isn't read for specifications or announced as new. `linked_products` records which go with which, in the store's order, and `/v1/products` serves it as `linked` (slugs). One that a category lists in its own right, or that is already watched, is observed as any other product. The product's own page words the choices in its collection's `sections` ("No Storage", "1 TB", "2 TB"): a section whose tag is the end of a linked product's slug (`ssd-1tb`, `uacc-ssd-1tb`) names that product's choice, and the most specific section made only of the product's own tags names having none (`linked_base_label`, `linked_products.label`). These are read when the product's page is, kept when a category page (which doesn't have them) observes the product again, and served as `linked[].label` and `linked_none`. The plan offers the choice on the product's row, under those names where known; picking one adds that product to the plan beside it. (The store ships the SSD with its tray as a bundle; the tray isn't modelled.)

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
| `product_metrics` | number | `poe_budget_w`, `power_draw_max_w`, `power_draw_excl_poe_w`, `switching_capacity_gbps`, `nonblocking_throughput_gbps`, `forwarding_rate_mpps`, `ids_ips_throughput_mbps`, `wifi_generation`, `nvr_cameras_hd`/`_2k`/`_4k` (how many cameras of each class an NVR manages; the first configuration when two are given), `app_network`/`app_protect`/`app_access`/`app_talk` (1 when the product runs that UniFi application: the flags under "UniFi Application Suite" of a gateway or console, or an NVR's "Management Application"; a camera, reader or phone naming the application that manages it doesn't count), `managed_devices` and `managed_access_hubs` (how many UniFi devices and access hubs a console manages, as published; `at_least` for "100+"), `camera_megapixels` (one sensor's resolution, from the pixel dimensions where given, else the headline), `camera_sensors` (how many, when more than one: "(4) 8MP", or a main and a package camera), `nvr_drive_bays` (an NVR's bays, from the first line of its storage entries that counts them) and `nvr_storage_tb` (the storage of an NVR with no bays: a microSD card, the CloudKey+'s SSD), `shadow_mode` (1 for a VRRP gateway pair: a flag or a line saying Shadow Mode), `hot_swap_psu` (1 for a CRPS flag or a power or redundancy line saying the PSUs or power modules are hot-swappable; fans and the external RPS don't count) and `pppoe_acceleration` (1 where an entry whose label names PPPoE is a true flag or says hardware acceleration: the store doesn't publish it, so it exists only where the owner adds the fact as an override, for the Cloud Gateway Fiber, the Industrial and the Gateway Fiber); with the text each came from |
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
| `GET /v1/debug/poller` | the poller's in-memory state, which neither SQLite nor the metrics hold and which a restart empties: when the process started, cycles finished, whether one is running and since when, the last one's duration and whether the store blocked it, the backoff factor, when the next is due, and `failing`: every item with a failed fetch since its last success (most failures first) with the consecutive count, whether the alert has gone out, the last error (cut to 500 bytes) and its `fetches_total` result. Needs no permission, like the other reads: it names products and store error text, not people |
| `GET /v1/status` | counts for the `/status` page: products, categories, specs and techspecs URL coverage, stock, activity, and `by_region`: each configured region's products, variants, in-stock count, ingested categories, newest and stalest check, how often it is read, and how many variants are overdue (unchecked for three read intervals) |
| `GET /health` | liveness; includes time of last completed poll |
| `GET /v1/history?days=` | each variant's status and price timeline over the last `days` (default 30, max 365), rebuilt from `events` |
| `GET /v1/variants?region=` | latest state of every variant |
| `GET /v1/events?region=&since=&limit=` | changes with `id > since`, oldest first |
| `GET /v1/products/{region}/{slug}/specs` | a product's effective specification (origin of each entry, published value beside an overridden one), its overrides with their status, and what is derived from it |
| `POST /v1/products/{region}/{slug}/refresh` | fetch one tracked product from the store now, instead of waiting for the next read, and record what it finds as a poll would: price and stock, group, specification (re-derived if it changed). Returns `{region, slug, title, variants, spec_entries, specs_changed, events}`. `404` for a product we don't track, `400` if the store no longer has it or has given the slug to another product, `502` if the store can't be reached. Notifications for any change it finds go out with the next poll. |
| `GET /v1/derived?region=` | what is derived for every product: ports, PoE budgets, radios, numbers, rack, size |
| `GET /v1/unifi-devices` | Ubiquiti's public list of devices (`static.ui.com/fingerprint/ui/public.json`) cut down to `{sku, name, type, shortnames, sysids}` for each, for the plan's UniFi import to tell what the model codes in a console's file are. Fetched on first use and then daily; the last good copy is served when a fetch fails, and 502 when there never was one. Needs no permission and holds nothing about anyone |
| `GET /v1/me` | who the service takes the caller to be and what they may do: `{mode, authenticated, open, user, name, email, roles, permissions}`; never cached |
| `GET /v1/overrides/history?region=&slug=&limit=` | the append-only record of changes to overrides, newest first: who, when, and the override before and after. Needs `overrides:write` |
| `GET /v1/overrides?region=&slug=` | overrides, each with its status (`overrides`, `hides`, `adds`, `orphan`), `stale`, and the value published now |
| `PUT /v1/overrides` | create or replace an override: `{"slug", "region" (optional), "action": "set"\|"hide", "section", "group" (optional), "label", "kind" (optional), "value", "note", "source_url", "reason"}` |
| `DELETE /v1/overrides/{id}` | remove an override |
| `GET /v1/specs/gaps` | the tracked products with no tech specs stored (`fetched_at` is null when the product page hasn't been read yet, so they may just not be collected) and the list of products marked as having none to expect, by slug without its region suffix (`created_by` only for those with `overrides:write`) |
| `PUT /v1/specs/not-expected` | `{"slug", "reason" (optional)}`: say no tech specs are expected for a product (a cable, a bracket), so a plan holding it isn't called unsure for lack of them. Keyed by the slug with its region suffix dropped, so it covers the product in every region. Needs `overrides:write` and takes the same cross-site checks and rate limit as overrides |
| `DELETE /v1/specs/not-expected/{slug}` | take a product off that list. Needs `overrides:write` |

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

### Query subcommand

`restock-radar query "SQL"` (`cmd/query.go`, `internal/dbquery`) runs before any of the service's start-up (no
logging setup, no migration, no config sync, no poller), so running it in the pod never touches state. It opens the
database with `mode=ro` and `query_only`, so every write is refused, and takes no write lock; under WAL it reads
alongside the running service. It exists because the image is `FROM scratch`: `kubectl exec` can run the binary
where there is no shell, `sqlite3` or `tar`. A database that doesn't exist is an error, not created. Output is TSV
(`NULL` written out, tabs and newlines escaped so a row is one line) or, with `--json`, an array of objects, capped
at `--limit` rows (default 1000).

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

## Not supported

Removing products from the UI, per-user subscriptions, device tokens, APNs/FCM,
anti-scalper measures (jitter, rate limits, device attestation), Live
Activities, trend analysis, and the six regions that only redirect. The event
history already stores what trend analysis would need. Per-user build plans and
saved-search alerts are described in [docs/ui-roadmap.md](docs/ui-roadmap.md).

## Open questions

- Whether the EU storefronts share one inventory pool, before adding EU.
- Whether Ubiquiti tolerates this at app scale. A fleet of clients each
  polling would be unacceptable, so the server must stay the single poller.

### NVR storage and retention

The drives of an NVR are plan lines like any product (`uacc-hdd-*`, the store's 1, 4, 16 and 24 TB; the 8 TB isn't offered), put there by the drive choice on the NVR's row with a quantity of the drives per NVR times the NVR's, so they are priced, stocked and shared like the rest. The NVR check (`lib/nvrChecks.ts`) deals the plan's drives out to the NVRs with bays, one at a time round them, up to the bays, and the M.2 SSDs sold with a gateway (its `linked` ones) one to a gateway. Drives in an array count at the smallest. `lib/nvrStorage.ts` has the RAID rules from help.ui.com (two drives RAID 1, three or more RAID 5, RAID 6 from nine on an NVR with that many bays, RAID 10 for an even number from four; hot spares aren't modelled) and the days: decimal TB × 8e6 / (Mbps × 86400), the Mbps being that of the cameras the check placed on the NVR. A camera's bitrate (`lib/cameraBitrate.ts`) is a rate for its resolution class, H.264 (HD 3, 2K 6, 4K 12 Mbps; scaled by megapixels past a 4K sensor's), times its sensors; a camera with a `camera_bitrate_mbps` metric uses that; the store doesn't publish one, so it exists only where the owner adds a fact labelled "Recording Bitrate" ("24 Mbps") to the camera. A camera of unknown resolution is left out of the days, and the row says so. An NVR with no drives in the plan is noted and isn't a problem, as the owner may have drives already.

### Topology graph

`lib/topology.ts` turns the checks' own arrangement into a tree for `components/TopologyGraph.tsx`: `planChecks` takes an optional `Trace` that the PoE check (which switch powers each non-switch device) and the switch-port check (each switch's uplink, each device's port, what got none) fill in as they run, so the graph and the checks can't disagree and nothing is worked out twice. Gateways are the roots (the root switch is, with no gateway); what has no uplink, port or power hangs from the first root as a dashed red "problem" box, in the tree where it would have gone. Each trace entry carries a `Link` (speed, port type, the device's best speed) and the checks add each switch's spare ports, PoE load and spare PoE ports, SFP misses, and which lines take rack space and outlets, so a box can say how it is plugged in ("Uplink: 10GbE SFP+", the warn colour when slower than the device could do, also shown as a dashed connector), its switch figures, rack height, outlets and stock. Each node lists the ids of the checks that concern it (`checks`); `PlanPage` holds the hover state, so pointing at a check outlines its boxes and pointing at a box tints its checks. The tree is nested lists joined by borders (`index.css`, `.topo`), so it is real markup and scrolls sideways when wide. The plan page chooses its layout in script (`useMediaQuery` at Tailwind's `xl`, 80rem) since the section opens by default only when wide, and the topology spans both columns above the plan and the checks, which are columns of their own, a grid of rows leaving a gap under the shorter one. The zoom is the CSS `zoom` property on the tree, which resizes its layout so the scroll area follows it; it is per visit, not remembered.

### Importing a plan from UniFi

"Import from UniFi" on the plan page makes a new plan from the equipment a console already has. It runs entirely in the browser: the page's policy allows only same-origin requests, and the file is never sent, stored or put in a link. `lib/unifiImport/` reads two kinds of file, each cut down at once to `{model, shortname, sysid, type}` of each adopted device, so MAC addresses, serials, names, passwords, keys and client lists are never held past the read.

- A **support file** (a gzipped tar) is streamed through `DecompressionStream`; every entry but `*/unifi/devices.json` is skipped without being kept, and reading stops at that one, so even a gigabyte support file costs little. It has the console's `shortname` ("U7PROXGS") and system id for each device.
- A **UniFi Network backup** (`.unf`) is AES-128-CBC under a key and IV that are the same for everyone and public. WebCrypto insists on PKCS#7 padding that the file lacks, so a block of valid padding is made (encrypting nothing with the last ciphertext block as the IV) and added. The result is a zip, read by its central directory, whose `db-config.jsonl.gz` holds the configuration as `table` lines (name, columns) each followed by that table's `row` lines; only the `device` table is read. Backups of versions before the move to PostgreSQL (a Mongo `db.gz`) and the whole-console UniFi OS backup (`.unifi`) are refused with a message saying so.

A console reports its own codes ("UAPA6A4", "USMINI"), not store SKUs. `/v1/unifi-devices` serves Ubiquiti's list of devices, and `match.ts` resolves each device by, in turn: the model among a device's names (`shortnames`, which is how the older codes are found), the support file's short name, the support file's system id, and the last four hex digits of the model (a newer model code ends in its system id: `UAPA6A4` is `a6a4`); the first to name exactly one device wins. The device's SKU (then its other names, regional suffixes dropped) is matched to a product's slug or a variant's SKU, letters and digits only, in the region's catalogue: the variant whose SKU is the device's if there is one, else the usual default. Devices of one kind are one row with a count, a quantity capped at what a plan line holds. A device Ubiquiti knows that the store doesn't list, one nothing identifies, and one that more than one product answers to are listed as not added, and the owner adds them from the page. The review lets rows be unticked, and "Create a plan" makes a new plan ("UniFi import", made unique), leaving the others alone; powering choices and controller hosting are not inferred.

### Equipment already owned

A plan holds what the owner has as well as what they mean to buy, so the checks see the whole build. A line's optional `owned` (0 to `qty`, kept as a fifth part of the saved text, `us/slug:SKU:3:19900:1`) says how many of its units are already had. Everything about the build (ports, PoE, rack, outlets, topology, NVR storage) counts all of `qty`; what concerns buying counts `buy = qty - owned` (`buyQty`, `LineView.buy`). The line's total is the price of `buy` units, so the plan's total is what is left to spend. A line with nothing left to buy is given the state `in` by `viewLine` whatever the store says, so the stock check, the finders and the role and PoE checks treat an owned item as available, and a variant the store dropped doesn't warn; a partly owned line is judged on its remaining units (the stock list shows `buy`). The store cart takes `buy` units and lists an all-owned line as "already owned". In a share link, `owned` is an entry numbered 2^29 + 2^28 plus the variant's, with the count where a quantity would be, after the powering entries; a link without them reads as owning nothing. "Import from UniFi" makes its lines all owned, since a console's devices are had already.

### Adding a plan to the store's cart

"Add to UniFi cart" on the plan page fills the visitor's own cart at the store. The store is another origin and its cart is the visitor's session, so the page can't do it; instead it makes a **bookmarklet** (`ui/src/lib/storeCart/bookmarklet.js`) that the owner drags to the bookmarks bar once and runs on a store page. Nothing is bought, and nothing leaves the browser but calls to the store's own cart API.

The bookmarklet is self-contained because the store's CSP (`connect-src`, `script-src`) would stop a loader, and a call back to this server, from its page. It is imported as text (`?raw`), stripped of comment lines and indentation, and wrapped as `javascript:` + `encodeURIComponent('void ' + source)` (`storeCart.ts`; the `void` stops the browser showing the script's value as the page). React 19 swaps a `javascript:` `href` for code that throws, so `AddToStoreCart` sets it on the element by hand; the link is only dragged or copied.

The plan reaches it as JSON, `{"v": 1, "n": name, "r": region, "i": [[variantId, sku, qty], ...]}`: in the fragment (`#rr=...`) of the store URL that the dialog's button opens (a fragment isn't sent to any server), and also copied to the clipboard; with no fragment the bookmarklet tries the clipboard, then asks for a paste. The ids are the `id` we keep for each variant, which is the store's `storeProductVariantId`, so no lookup is needed. Each store (region) has its own host, cart and ids, so a plan holding several regions is offered one store at a time (a picker in the dialog, shown only then, starting on the region the site is showing); the store's origin and locale come from the products' own links. One bookmark serves every region. Because the clipboard fallback can hold another region's plan, the bookmarklet compares the plan's `r` with the first segment of the page's path (`us`, `eu`: the region ids) and stops before touching the cart on a mismatch; a plan with no `r` (an older plan page) isn't checked. Lines that aren't `Available` are left out and listed; so are lines that are all owned ("already owned"), and a line partly owned goes in with only the quantity still to buy. A plan is read strictly (UUID ids, whole quantities of 1 to 99), since the fragment is data from a URL.

It tops the cart up rather than adding: the quantity the store's API takes is a change (`-1` removes one), so it reads what the cart holds, adds the difference for each product (one request each, so one refusal doesn't lose the rest), and shows what it will do and asks first. Run twice, the second changes nothing. Then it opens the cart.

**When the store changes** this is the part that breaks, and the bookmarklet's header lists exactly what it relies on. Re-derive each from the store's own "Add to Cart" with the browser's network tab:

1. `window.__APOLLO_CLIENT__.cache.extract()` holds an `ActiveCheckout` record (`id`, `secret`, `storeId`) and a `StorefrontCheckout` record whose `language.locale` the calls must repeat. With no `ActiveCheckout` (a visitor who has never added anything) the bookmarklet asks for one item to be added first; making a checkout itself (`storefrontCreateCheckout`) and teaching the page about it was left out as unverifiable without a fresh session.
2. `POST https://ecomm.svc.ui.com/graphql`, cookies included, mutation `storefrontUpdateCheckout` with `input: {id, secret, language, updateItems: [{storeProductVariantId, quantity}]}`; errors arrive as HTTP 200 with a top-level `errors`.
3. The read query `storefrontCheckout(input: {id, secret, language})`, and the response shape `checkout.items[].{sku, quantity, variant.id}`.
4. The cart's address, `/<region>/<language>/cart`.

An old bookmark can't be updated from here, so a change to the payload bumps `PLAN_FORMAT` (and the bookmarklet's `VERSION`): a bookmarklet older than the plan it is given says to drag a new copy. `bookmarklet.test.ts` runs the built text against a fake store, so a change to the bookmarklet itself is tested; a change to the store is not, and shows up as the "something went wrong" message. Browsers run a bookmarklet outside the page's CSP (Chrome, Firefox and Safari do); one that doesn't would need the same code pasted into the developer console.
