# restock-radar

A small Go service that watches products on the [UniFi store](https://store.ui.com)
and sends an [ntfy](https://ntfy.sh) notification when stock or price changes.

It reads the JSON the store's Next.js frontend already serves
(`/_next/data/...`), so it needs no browser. See [DESIGN.md](DESIGN.md).

## Run

```sh
cd src
CONFIG_PATH=../config.example.yaml go run ./cmd
```

Copy [config.example.yaml](config.example.yaml) and edit the ntfy settings and
item list. Items are product slugs from store URLs
(`store.ui.com/us/en/.../products/<slug>`).

The first poll records a baseline and sends nothing. After that you get a
notification for each stock status change and each price change.

Products in the same store category as an item you watch are discovered
automatically: they're tracked from then on, and you're notified ("New
product!") when one first appears. Products already listed the first time a
category is read are tracked silently. Discovered products don't count toward `max_items`.

Products the store sells with another (a gateway's SSDs) are tracked too, from the category page, and the plan offers them on the product's row.

Each cycle also fetches up to five products that have never been read from their own product page, to learn the store's grouping for them (category pages don't carry it). A large catalogue fills in over a day or two.

Every configured region is asked about every category any region has, so each region's own catalogue is tracked without listing its products. A category a region has no page for is asked about again after a day. Notifications for a region other than the US start with its label (`[EU]`).

A region's `poll_every` (e.g. `1h`) rolls it: instead of reading the whole region each cycle, each cycle reads the share that has waited longest (with a 5-minute `poll_interval` and `poll_every: 1h`, a twelfth of its category pages). Left out, a region is read every cycle. After a restart a rolling region simply starts over from its least-recently-read pages.

The web UI can filter by any of the store's product tags (`black-friday`, `feature:color-black`, ...). Choosing several shows products that have all of them.

## Container

```sh
docker run -v /path/to/config.yaml:/etc/restock-radar/config.yaml:ro \
           -v restock-data:/data -p 8080:8080 jakerobb/restock-radar
```

The image is `FROM scratch` and runs as UID 65532, so `/data` must be writable
by that user (in Kubernetes, `fsGroup: 65532`). Run a single replica.

## Configuration

| Key | Default | |
|-----|---------|--|
| `poll_interval` | `20m` | time between passes over the watch list |
| `poll_jitter` | `1m` | each wait is `poll_interval` ± this |
| `request_delay` | `2s` | average pause between products in a pass |
| `http_port` | `8080` | |
| `db_path` | `/data/restock-radar.db` | |
| `user_agent` | `restock-radar (+...)` | |
| `failure_alert_after` | `3` | consecutive failures before an alert |
| `max_items` | `200` | cap on the watch list; adding past it is refused |
| `backup_dir` | | where to copy the database; empty turns backups off |
| `backup_interval`, `backup_keep` | `24h`, `14` | how often, and how many copies to keep |
| `ntfy.url`, `ntfy.topic`, `ntfy.token` | | `${ENV_VAR}` is expanded |
| `regions[]` | US | `id`, optional `poll_every` (see below), and for a region the store doesn't list, `base_url` and `path` (e.g. `us/en`). Built in: `us`, `ca`, `eu`, `uk`, `jp`, `br`, `tw`, `sg`; a bare `{id: eu}` is enough |
| `items[]` | | `slug`, optional `region`; may be empty if you add products in the UI |

The config is read from `CONFIG_PATH`, else `/etc/restock-radar/config.yaml`.
`LOG_LEVEL=debug` turns on debug logging.

## Web UI

The server's root (`/`) is a React app (source in [ui/](ui/)): every tracked
product with its variants grouped underneath, each variant's stock status and
price (struck-through regular price when discounted), and the time of the last
sync. Under each product, a chart per variant shows the last 30 days: price as
a line, stock status as the background (green in stock, red sold out, yellow
coming soon, white where nothing was observed). A form at the top adds a product by slug (`ucg-fiber`, case-insensitive)
or by pasting its store URL. The product is checked against the live store
first, so a typo is rejected with a message instead of being saved.

A dropdown at the top (with the store's flags) picks which region's products the site shows, and appears when more than one region is tracked. It starts at the region your browser's language points to (`en-GB` is the UK, `de-DE` Europe, `ja` Japan, ...) and remembers what you choose in the browser. Lists, the finder, compare and the plan's "add" searches follow it; a product page link or a plan keeps whatever regions it already names.

On the plan page, "Convert to another region" remakes the plan from another store's products, matching each line to the store's product (by its id or slug, and for the few the store sells separately in each region, such as `ups-tower-us` and `ups-tower-eu`, by the slug without its region, then the title) and its variant by SKU (a region's own SKU, such as `UNAS-2-B-EU` for `UNAS-2-B`, counts, and where a store lists several, such as an EU and a UK plug, the one made for that region), then by name. It lists what that store doesn't sell and opens the result in a new tab as a shared plan, priced in that store's currency, so your own plan stays as it is and the two can be compared.

"Import from UniFi" makes a new plan from the equipment a UniFi console already has. Give it a support file (Settings, System, Support File; the one with only UniFi Network in it is quickest) or a UniFi Network backup (`.unf`) and it lists the devices it found as products of the store you are viewing, with the quantity of each, at today's prices; tick or untick what to include and it makes a new plan. The file is read in your browser and isn't uploaded: only each device's model is kept, never its address, serial, name or any password or key in it, and the only request made is for Ubiquiti's public list of device codes (`GET /v1/unifi-devices`) that tells the model codes apart. Devices the store doesn't list, or that can't be identified, are named so you can add them yourself. A UniFi OS backup (`.unifi`) of the whole console can't be read.

Other pages (client-side routes; the server falls back to `index.html` for them):

| Path | What |
|---|---|
| `/p/{region}/{slug}` | One product: variants and history, what is derived from its specification (ports, PoE, radios, rack, size), and the full specification with any overrides shown beside the published value. A "Refresh from store" button reads the product from the store now |
| `/find` | The product finder: pick a type, add requirements ("a 10 GbE port with PoE+++ out", "a 6 GHz radio", "PoE budget ≥ 200 W"), see matching products with current price and stock, sortable. Products whose specs don't say enough go under "Can't tell" instead of being dropped. The whole search is in the URL, so it can be bookmarked or shared. Columns include price per PoE watt, per port, per Gbps and per ft² of coverage, and up to four products can be ticked for comparison |
| `/compare` | Up to four products side by side: price and stock, price per unit, performance and power, ports, radios and size, with the best number marked and an option to show only the differences. The products are in the URL |
| `/plan` | The build plan: the products you intend to use, each with a variant and quantity, live prices, a total and whether it is all in stock. It checks PoE power, ports, rack space, NVR storage and controllers from the derived specs, draws the result as a topology, and suggests products that fix what falls short. Plans are kept in the browser and shared by link; nothing is bought here. See [docs/build-plan.md](docs/build-plan.md) |
| `/status` | Collection status in four tabs (Stats, Products without tech specs, Parser issues, Spec overrides). Stats has a row for each region: what it holds, how often it is read, and how fresh it is; the second tab lists the products with no usable tech specs, and the third lists the products whose specs the parsers couldn't read, or read two ways that disagree (the same issues `/v1/derived` carries); the last tab lists every spec override by product, the official value beside the override, and lets an editor add, change or remove one |

The finder filters in the browser: it fetches `/v1/derived` and `/v1/products`
once and matches locally (`ui/src/lib/requirements.ts`). The plan for what
comes next is in [docs/ui-roadmap.md](docs/ui-roadmap.md).

There is no login of its own: see [Access control](#access-control). Corrections
to a product's specification are made on its page by anyone allowed to, and the
specification shows them beside what the store publishes.

The UI is compiled to static files and embedded in the Go binary, so the image
is still one `FROM scratch` binary with no Node at runtime.

### Where the watch list lives

The watch list is in the database. `items:` in the config file is
authoritative for the entries it lists: they're added at startup, and removing
one from the config unwatches it at the next start. Products added through the
UI are kept separately and survive restarts and config changes. If you later
put a UI-added product in the config, the config takes it over.

## Investigating a deployment

The image has no shell or `sqlite3`, but `kubectl exec` can run the binary itself:

```sh
kubectl -n restock-radar exec deploy/restock-radar -- /restock-radar query --schema
kubectl -n restock-radar exec deploy/restock-radar -- /restock-radar query \
  "SELECT * FROM events ORDER BY id DESC LIMIT 20"
```

`restock-radar query` runs one read-only SQL statement against the database (the config's `db_path`, or `--db`)
and prints tab-separated rows (`--json` for JSON, `--limit N` to cap them, `-` to read the statement from stdin).
The connection refuses writes and doesn't hold the write lock, so it is safe against the running service. For the
state that isn't in the database, `GET /v1/debug/poller` reports the poller's cycle timing and backoff and every
item whose fetches are failing, with the last error. See
[`.claude/skills/restock-radar-debug`](.claude/skills/restock-radar-debug/SKILL.md) for the full playbook.

## API

```
GET /health
GET /metrics              Prometheus format
GET /v1/products
POST /v1/items            {"item": "ucg-fiber" | "<store URL>", "region": "us"}
GET /v1/history?days=30   per-variant price and status timeline
GET /v1/variants?region=us
GET /v1/events?region=us&since=0&limit=100
GET /v1/status           counts behind the /status dashboard page
GET /v1/debug/poller      the poller's in-memory state: cycle timing, backoff, failing items and why
GET /v1/products/us/ucg-fiber/specs   effective specification, overrides, derived facts
GET /v1/derived?region=us             ports, PoE budgets, radios, numbers, rack and size for every product
POST /v1/products/us/ucg-fiber/refresh  fetch this tracked product from the store now (price, stock, specs)
GET /v1/overrides?slug=ucg-fiber
GET /v1/overrides/history?slug=ucg-fiber   who changed which corrections, and what they were before
GET /v1/specs/gaps          products with no tech specs stored (fetched_at null: not collected yet), and those marked as having none to expect
PUT /v1/specs/not-expected  {"slug": "cable", "reason": "optional"}   no specs expected for this product, in any region (a slug in any region, without or with its suffix)
DELETE /v1/specs/not-expected/{slug}
GET /v1/me                  who you are to the service, and what you may do
PUT /v1/overrides        {"slug": "ucg-fiber", "action": "set", "section": "Overview",
                          "label": "IDS/IPS Throughput", "value": "8+ Gbps",
                          "source_url": "https://...", "reason": "teardown"}
DELETE /v1/overrides/{id}
```

Prices are integers in minor units (cents) with a `currency` field.

## Access control

Reading is open to everybody. Changing things needs a permission:

| Permission | Allows |
|---|---|
| `overrides:write` | creating, changing and removing spec corrections, and seeing who made them and the history |
| `products:refresh` | reading a product from the store on demand |
| `watchlist:write` | adding products to the watch list |

There is no login: who somebody is comes from the config's `auth` block.

- **`mode: open`** (the default) treats every request as an administrator's. Use it only where nobody
  else can reach the service. `public: true` is refused in this mode.
- **`mode: proxy`** believes the identity an authenticating reverse proxy forwards in headers
  (`Remote-User`, `Remote-Name`, `Remote-Email`, `Remote-Groups`: Authelia's names; each can be changed),
  but only on requests whose connection comes from one of `trusted_proxies`. A request from anywhere else
  is anonymous however it is dressed, and `X-Forwarded-For` is never consulted. `roles` maps proxy groups
  to the roles `editor` (`overrides:write`, `products:refresh`) and `admin` (those plus `watchlist:write`).
  Trusting every address is refused.

A configuration that can't be made sense of leaves nobody able to change anything, rather than everybody.
`GET /v1/me` says who the service takes you to be and what you may do, which is what the web UI uses to
offer only what will work. Every correction records who made it, and its history is kept.

## Backups

Set `backup_dir` and the service writes a consistent copy of its database
there every `backup_interval` (`restock-radar-YYYYMMDD-HHMMSS.db`, UTC),
keeping the newest `backup_keep`. It uses SQLite's `VACUUM INTO`, which reads a
snapshot, so it's safe while the poller is writing. The schedule is anchored on
the newest existing copy, so restarting the service doesn't take extra backups.
Point `backup_dir` at a different volume (or machine) from `db_path`, or a lost
volume loses the backups too.

What's worth backing up is the products added through the UI, which live only in
the database (config items are in git), plus the change history.

To restore: stop the service, copy the backup over `db_path` (delete any
`-wal` and `-shm` files next to it), and start it again.

## Metrics

`/metrics` serves Prometheus metrics, all prefixed `restock_radar_`:

| Metric | Type | |
|--------|------|--|
| `last_success_timestamp_seconds` | gauge | last successful product fetch; starts at process start time, so a poller that never succeeds still ages |
| `last_cycle_timestamp_seconds` | gauge | when the last poll cycle finished |
| `fetches_total{result}` | counter | `ok`, `blocked` (403/429/503), `not_found`, `schema` (JSON changed shape), `error` |
| `events_total{kind}` | counter | changes detected: `status`, `price` |
| `notifications_total{result}` | counter | `sent`; `failed` (an attempt that will be retried); `dropped` (rejected for good by ntfy, given up on) |
| `items_failing` | gauge | watched items whose last fetch failed |
| `watched_items`, `pending_events` | gauge | watch list size; detected changes not yet delivered |
| `variants{status}` | gauge | tracked variants by store status |
| `last_backup_timestamp_seconds` | gauge | last successful backup (only when backups are on) |
| `backups_total{result}` | counter | `ok`, `error` (only when backups are on) |

To alert on a stalled poller: `time() - restock_radar_last_success_timestamp_seconds > 3600`.
To alert on stuck notifications: `restock_radar_pending_events > 0` for longer than a poll
interval, or any increase in `notifications_total{result="dropped"}`.

## Development

Server (Go 1.27):

```sh
cd src
go vet ./... && go test ./...
CONFIG_PATH=../config.example.yaml go run ./cmd
```

Web UI (Node 22.12+ or 24; `ui/.nvmrc` says 24):

```sh
cd ui
npm ci
npm run dev        # http://localhost:5173, proxies /v1 to the Go server on :8080
npm run lint && npm test && npm run build
```

A plain `go build` embeds whatever is in `src/internal/webui/dist/` (empty by
default, in which case `/` says the UI wasn't built). To embed the real UI
locally: `npm run build` in `ui/`, then copy `ui/dist/*` into
`src/internal/webui/dist/`. The Dockerfile does exactly that.

### UI structure

- `src/api/`: typed fetch client, request/response types, and the React Query
  hooks. Nothing else in the app calls `fetch`.
- `src/lib/`: pure functions (money and time formatting, status wording and
  summaries), unit-tested without React.
- `src/components/ui/`: styled primitives (`Card`, `Badge`, `Notice`, `Button`,
  `TextInput`). They own appearance; `tone.ts` is the single map from a tone
  (ok/bad/warn/neutral) to colours.
- `src/components/`: feature components (`ProductCard`, `VariantTable`,
  `VariantRow`, `PriceTag`, `StatusBadge`, `AddProductForm`, ...) that compose
  the primitives and add layout only.
- `src/index.css`: the design tokens (semantic colours, light and dark). Components
  use `bg-surface` and `text-muted`, never raw colours, so restyling happens there.
