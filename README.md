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

On the plan page, "Convert to another region" remakes the plan from another store's products, matching each line by the store's product and its variant by SKU (a region's own SKU, such as `UNAS-2-B-EU` for `UNAS-2-B`, counts), then by name. It lists what that store doesn't sell and opens the result in a new tab as a shared plan, priced in that store's currency, so your own plan stays as it is and the two can be compared.

Other pages (client-side routes; the server falls back to `index.html` for them):

| Path | What |
|---|---|
| `/p/{region}/{slug}` | One product: variants and history, what is derived from its specification (ports, PoE, radios, rack, size), and the full specification with any overrides shown beside the published value. A "Refresh from store" button reads the product from the store now |
| `/find` | The product finder: pick a type, add requirements ("a 10 GbE port with PoE+++ out", "a 6 GHz radio", "PoE budget ≥ 200 W"), see matching products with current price and stock, sortable. Products whose specs don't say enough go under "Can't tell" instead of being dropped. The whole search is in the URL, so it can be bookmarked or shared. Columns include price per PoE watt, per port, per Gbps and per ft² of coverage, and up to four products can be ticked for comparison |
| `/compare` | Up to four products side by side: price and stock, price per unit, performance and power, ports, radios and size, with the best number marked and an option to show only the differences. The products are in the URL |
| `/plan` | The build plan: the products you intend to use, each with a variant and quantity, live prices, a total, and whether it is all in stock. It also checks that the PoE devices fit the PoE switches' budget and that there are ports of a high enough class for them (a PoE++ device needs a PoE++ port), warns when a device has a faster port than the PoE ports it would be given (a 10 GbE access point on a 2.5 GbE port), and adds up the rack space (naming desktop equipment that needs a shelf instead, the Instant and the CloudKey+ included; a rack-mount accessory in the plan counts its own rack space and takes what it holds off that list: six AI Ports, three AI Keys, or one each of a CloudKey+, a Pro Max 16 and a Cloud Gateway Industrial, which count as desktop without one; the store doesn't say what an accessory fits, so that is stated in the code; the list is numbered by rack unit, a 2U device appearing twice, and the OCD panels count by the height in their variant), saying "can't tell" when a number isn't known; it also counts the AC outlets (each device that runs on the mains rather than PoE takes one, a switch by the input chosen for it). A switch that can be powered several ways, with a different PoE budget for each (the Flex 2.5G PoE: 16 W on PoE+ up to 196 W on its optional 210 W adapter; the Ultra family), gets a "Power for" choice on its row, kept with the plan and in its share link; until it is chosen the PoE power check says it can't tell (a switch with its power supply in the box needs none), and choosing an adapter the store sells separately adds it to the plan, one for each switch, and choosing PoE makes the switch a PoE device on the switch upstream, drawing its own power and that of the devices on it, with the budget of the port it is plugged into (PoE+ or PoE++ gives that class's figure); a product of the same range that comes with an adapter (the Ultra 60W, the 210W) is an option too, which changes the product. The finders ("Find a switch", "Find an NVR", "Find a gateway or controller") can be narrowed to rackmount (a switch, gateway or NVR that needs an accessory to go in a rack comes with it, priced and added together) or not, to hot-swappable power supplies (CRPS), and, for gateways, to hardware PPPoE acceleration (which the store doesn't publish: add it as a fact to the product, a flag labelled "PPPoE Hardware Acceleration" that is true), shadow mode, and a minimum IDS/IPS throughput; a product that doesn't state a property isn't taken to have it. A collapsible "Topology" section draws the plan as a family tree (the gateway at the top, the switches under what they uplink to, and the devices under the switch they were given a port or PoE power on, identical ones in one box with a count; one arrangement the checks found, product names only, not to scale): below the plan and shut on a narrow screen, across the full width above the plan and the checks, and open, in the two-column layout; a zoom control (50% to 200%) scales it, since it is wider than it is tall. Each PoE device is placed on a specific switch and port group, each switch with its own budget, and the layout can be expanded. When the PoE power or ports fall short, "Find a switch" tries every PoE switch we track added to the plan (and a few of the same) and suggests the cheapest that fits, the cheapest at full speed and the one with the most room; when no one model does, or two different switches (say a 10G one for the access points and a gigabit one for the cameras) cost less, it suggests a pair (pairs are in the full list too). "Add product" opens a quick search (name, SKU, category; arrow keys and Enter, or click) that adds a product straight to the plan. With cameras in the plan it also checks for an NVR with room for them (each camera takes 1/capacity of an NVR for its resolution class, a rough linear estimate) and offers "Find an NVR" when there is none, it is full or one in the plan is sold out (stand-ins replace it). An NVR with drive bays (a UNVR, an ENVR, a Dream Machine) gets a drive choice on its row, a size (1, 4, 16 or 24 TB, what the store sells) and a number up to its bays, which puts those drives in the plan with it; the NVR check then gives, for each NVR, the effective storage for each way the drives can be protected (two are mirrored, three or more RAID 5, nine or more can be RAID 6, an even number from four RAID 10) and how many days of its cameras' footage that holds, at an assumed bitrate for each camera by resolution and number of sensors (a guess, to be tuned against UniFi's capacity calculator; the finders don't consider storage). The same goes for the SSD a gateway is sold with and the storage that comes built in. Gateways that record too (Cloud Gateways, Dream Machines and Routers) count as NVRs, and the finder may suggest one. The UNVR Instant's built-in PoE ports take part in the PoE checks. Every other device with a network port (an NVR, a cloud key, a PoE injector) needs a switch port too, and so does every switch, for its uplink. The plan is wired like a network builder would: the switch with the most SFP-style cages is the root and uplinks to the gateway (the gateway itself needs no port, and the internet connection isn't modelled); every other switch uplinks to the root while it has a port, and only then to another switch (flat before deep), with the gateway's other ports a last resort. SFP-style cages are preferred for every uplink and for devices that have an SFP port, then copper; a copper-only device may use a cage through a module when no copper port is left, and a device with only an SFP port needs a cage. Uplinks keep to ports that aren't PoE where they can, a switch's PoE-in port is its own uplink, and a combo pair counts once. The layout can be expanded. A switch with SFP cages that has to be uplinked over copper for want of a free cage upstream gets a warning recommending something with more SFP connections (usually an aggregation switch; a Pro HD with four SFP+ can act as a small one). "Find a switch" also covers a shortfall of ports or of SFP uplinks. The plan also needs something to fill each role it uses: a gateway and a Network controller for anything on the network (many products are both, a Cloud Key is only a controller, a UXG-Lite only a gateway), an Access controller for door hubs, intercoms, readers and kits, a Talk controller for phones, and, for cameras, the Protect controller that the NVR check already covers. A role filled only by something that can't be bought now counts as missing. "Find a gateway or controller" suggests the cheapest product that fills every missing role (or a pair when none does), and the one running the most applications; gateways are described by their IDS/IPS throughput ("5 Gbps gateway"). The Network controller must manage at least as many UniFi devices as the plan has (gateways, switches, access points and the like; a published "100+" is a minimum, so exceeding it only warns), and the Access controller as many hubs as the plan has door hubs, intercoms and kits; the largest controller in the plan counts, and a controller that is too small is replaced by the finder. Protect's limit is the camera counts of the NVR check; Talk states none. A controller whose capacity the store doesn't state is offered after those that can be shown to fit. The finder also offers pairs that fill the roles between them (a Gateway Lite and a Cloud Key can undercut a console), and, for the Network, Access and Talk controllers, self-hosting them: an entry in the plan (not a product, so no price or stock) that is carried in its share link, counts as filling the role (capacity isn't checked) and can be removed. Official UniFi Hosting, the cloud-hosted Network controller (a monthly subscription, up to 1,000 devices), is a product like any other and is offered and counted that way; the store gives it no specifications, so what it runs is stated in the code. The UXG gateways, which the store files as accessories, count as gateways (any product stating an IDS/IPS throughput does); a gateway always has to be a product. More than one thing running UniFi Network in a plan is a warning (a site has one; the extras probably belong to another site). It also offers when a port-speed warning or a sold-out switch is the problem (a sold-out switch is checked without, and replaced), and never suggests a switch that leaves a device below 1 GbE. Each suggestion says how the switch is powered; a filter (AC and PoE by default, DC optional) narrows the list, and the full list of switches that would work can be expanded. One plan, kept in this browser; a short link (`/plan/{slug}`: each line's variant number and quantity) carries it to someone else, who can keep a copy. Nothing is bought here |
| `/status` | Collection status, with a row for each region: what it holds, how often it is read, and how fresh it is |

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
