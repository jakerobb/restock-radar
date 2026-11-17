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

Each cycle also fetches up to five products that have never been read from their own product page, to learn the store's grouping for them (category pages don't carry it). A large catalogue fills in over a day or two.

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
| `regions[]` | US | `id`, `base_url`, `path` (e.g. `us/en`) |
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

Other pages (client-side routes; the server falls back to `index.html` for them):

| Path | What |
|---|---|
| `/p/{region}/{slug}` | One product: variants and history, what is derived from its specification (ports, PoE, radios, rack, size), and the full specification with any overrides shown beside the published value. A "Refresh from store" button reads the product from the store now |
| `/find` | The product finder: pick a type, add requirements ("a 10 GbE port with PoE+++ out", "a 6 GHz radio", "PoE budget ≥ 200 W"), see matching products with current price and stock, sortable. Products whose specs don't say enough go under "Can't tell" instead of being dropped. The whole search is in the URL, so it can be bookmarked or shared. Columns include price per PoE watt, per port, per Gbps and per ft² of coverage, and up to four products can be ticked for comparison |
| `/compare` | Up to four products side by side: price and stock, price per unit, performance and power, ports, radios and size, with the best number marked and an option to show only the differences. The products are in the URL |
| `/plan` | The build plan: the products you intend to use, each with a variant and quantity, live prices, a total, and whether it is all in stock. It also checks that the PoE devices fit the PoE switches' budget and that there are ports of a high enough class for them (a PoE++ device needs a PoE++ port), and adds up the rack space, saying "can't tell" when a number isn't known. One plan, kept in this browser; a link carries it to someone else, who can keep a copy. Nothing is bought here |
| `/status` | Collection status |

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
GET /v1/products/us/ucg-fiber/specs   effective specification, overrides, derived facts
GET /v1/derived?region=us             ports, PoE budgets, radios, numbers, rack and size for every product
POST /v1/products/us/ucg-fiber/refresh  fetch this tracked product from the store now (price, stock, specs)
GET /v1/overrides?slug=ucg-fiber
GET /v1/overrides/history?slug=ucg-fiber   who changed which corrections, and what they were before
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
