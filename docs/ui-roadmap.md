# UI, product finder, and system builder: plan

Status: built so far are the router, product pages, the finder (spec table, requirement chips, URL state, three-outcome matching, price-per-unit value sorts), the compare view, the first build plan (browser-only), the on-demand product refresh, AP coverage as a derived metric, the access-control seam (permissions, proxy-header identity, override attribution and history), and the override editor on the product page. Everything after that is still plan. The backend half (raw specs,
derived specs, overrides) is described in [DESIGN.md](../DESIGN.md#derived-specifications-and-overrides).

The goal is to turn the collected data into something people can use:

1. A product page for every product.
2. A product finder: state what you need, see which products meet it, with
   current price and stock.
3. A build plan (cart-like in how it lists products and totals them, but
   nothing can be bought here), and saved searches that alert.
4. Compare, alternatives, value sorts, and a rack planner.
5. Much later, a system builder that turns a description of your network into
   a recommended bill of materials at a few budget levels.

The site will eventually be public, so access control is part of the plan
([Access control](#access-control)), even though login is not built yet.

## Principles

- **One requirement language.** A *requirement* ("has a 10GbE PoE+++ port",
  "6 GHz radio", "PoE budget >= 200 W", "fits a 10-inch rack") is the common
  currency. The finder takes requirements from the user, saved searches store
  them, and the system builder generates them. Build it once, test it hard.
- **Unknown is not false.** The derived data says what it knows
  (`known.ports`, `known.poe`, ...). Matching has three outcomes: matches,
  doesn't match, can't tell. "Can't tell" products are shown in their own
  collapsed group, never dropped silently.
- **Explain every answer.** A match says which port or radio satisfied which
  requirement; a recommendation says why it was chosen and what it assumed.
  Wrong advice costs more than a missing field.
- **Published values stay visible.** Wherever an override changes a value, the
  published value is shown beside it.
- **The browser filters; the API stays light.** The whole derived catalogue is
  about 500 products. The UI fetches `/v1/derived` and `/v1/products` once,
  joins them, and filters locally. Matching logic is TypeScript, kept in one
  pure, well-tested module. A server-side `/v1/find` is added only if the
  builder or a non-browser client needs it.
- **Live price and stock is the edge.** Static design tools can't say "this
  build is in stock now for $X". Everything that recommends products shows
  current availability.

## Data work that comes first

The finder and builder need a few fields we don't derive yet.

| Need | Source | Work |
|---|---|---|
| AP coverage area | Published as text like `115 m² (1,250 ft²) Coverage` on APs (also "open space coverage" variants) | New derived metric (`coverage_m2`, keeping the ft² figure as the raw text). Validate against the whole catalogue like the other parsers, then bump `specs.Version`. |
| PoE demand of a device | `power_draw_max_w` already derived for APs and cameras | None. The builder sums these to size a switch's PoE budget. |
| Camera bitrate / storage per day | Not published | Estimate from resolution, codec and frame rate, then fact-check against the UI capacity calculator by hand (not scraped). Record the findings as overrides (added metrics with a `source_url`), so they are visible, editable and attributable. |
| Rack data for 19" and 10" | `rack` and `dims` already derived (414 of 498 products have dimensions) | Rules for the 10" case once the planner is built. The 34 multi-part kits need overrides. |

## Phase 1: router and product pages

- Add a router. TanStack Router is the leading option since the UI already uses
  TanStack Query: its typed search params let all finder state live in the URL,
  so every search is bookmarkable and shareable.
- Routes: `/` (existing list), `/p/{region}/{slug}` (product), `/status`
  (existing status page), later `/find`, `/compare`, `/plan`, `/racks`.
- The Go server must serve `index.html` for unknown non-API paths so deep links
  work. Verify this first.
- Products the store treats as one (shared collection, merged in the UI) get one
  canonical product URL; the other slugs redirect to it.
- The product page shows: effective specs (with override badges and the
  published value beside each), derived summary (ports, PoE, radios, rack,
  dimensions), variants with price and stock, and the history chart.
- Read-only at first. The override editor comes in phase 3.

## Phase 2: spec table and finder

1. **Spec table.** A sortable table over the derived fields with a column
   picker, filtered by product type first (antenna gain means nothing for a
   switch). This answers "sort APs by TX power" before any guided flow exists,
   and it shows where data is missing.
2. **Requirement chips on top.** Each chip is one requirement, URL-encoded.
   Results show which port or radio satisfied each chip and the cheapest
   in-stock variant's out-the-door price (falling back to the last seen price).
   Products with unknown data go in a "can't tell" group.
3. **Value sorts**: price per PoE watt, per PoE port, per 10G port, per Gbps
   switched, per ft² of coverage. These are ordinary sortable columns (cheapest
   per unit first), listed apart in the column picker, and blank when the price
   or the quantity is unknown.

Price and stock are per variant; a product row summarises its variants.

## Phase 3: overrides in the UI

An editor on the product page over the existing override API: set, hide or add
a value, with a source URL and note, shown next to the published value. Stale
overrides (published value changed since) are flagged.

This is gated by [access control](#access-control). Until login exists the
editor is only available on a private deployment.

## Phase 4: build plan and saved searches

The build plan is where you collect what you intend to use. It lists products the
way a cart does, with a total, but nothing is bought here: it is a plan for a
system, and the name says so.

- **Lines** are products (with a chosen variant and a quantity) or saved
  searches. Each product line shows live price and stock; the footer shows the
  total (out-the-door, with surcharges) and "all in stock" or which lines
  aren't.
- **Saved searches** are a set of requirements plus optional limits ("under $X",
  "in stock"). They alert through ntfy when a matching product becomes
  available or drops below the limit. This extends the radar's core job from a
  hand-picked watch list to needs.
- Distinct from the existing watch list (config-driven items the poller
  tracks).
- **Built so far:** one plan, kept in the browser, with product lines (variant and
  quantity), live prices, totals, a link that carries the plan, and checks
  (PoE power and ports, rack space) worked out from derived specs. Still to do:
  named plans, saved searches as lines, server-side storage and alerts.
- Anonymous visitors keep a build plan in the browser (localStorage), shareable
  as a link. Signed-in users get one stored on the server, which saved-search
  alerts require, since an alert needs to know where to send itself. Per-user
  subscriptions are currently out of scope in DESIGN.md; this phase brings them
  in, together with per-user ntfy topics or another delivery channel to be
  decided then.

## Phase 5: compare, alternatives, rack planner

- **Compare** (built): 2-4 products side by side at `/compare`, picked from the
  finder or added by name, with the best number marked and an option to show only
  the rows that differ. Override-aware, since it reads the derived specs.
- **Alternatives** on the product page: cheaper or in-stock products with
  similar derived specs.
- **Rack planner**: choose a 19" or 10" rack and a number of U; add products and
  shelves; the planner sums heights and checks width and depth. 10" fit is a
  query-time check against the sorted dimensions. The usable-width rule is
  settled when this is built. Rack-mountable and shelf-mounted items are both
  handled. Rack plans can be added to the build plan.

## Phase 6: system builder

Not a monolithic wizard. The builder is a **requirement generator**; the finder
is the **engine**; a **bill-of-materials step** assembles the results.

Each question yields requirements in the shared language:

- ISP speed and WAN type: gateway ports, IDS/IPS throughput at least the ISP
  speed with IDS/IPS on (override-corrected where the rating understates real
  performance).
- Client devices: from a **catalogue picker** (cameras, doorbells, APs, etc.
  taken from the product catalogue) plus a few generic types (laptop, TV).
- PoE devices: total draw drives the switch PoE budget and port counts.
- Wi-Fi coverage: area in sq ft or m² against AP `coverage_m2`, as a labelled
  heuristic. No floor-plan or RF modelling; Ubiquiti has its own design tools.
- Camera retention: cameras x estimated bitrate x days gives NVR storage.
- Rack: units and width from the rack planner.

Roles (gateway, switches, APs, NVR) are mostly independent, so a greedy or
brute-force pick per role is enough; no solver. Output is a few budget tiers:
cheapest that meets the need, balanced with headroom, and future-proof (10G,
6 GHz). Every pick explains itself and lists its assumptions. Curated rules the
specs don't contain (SFP module and cable matching, accessory compatibility)
are kept as data, not code.

Smallest useful first slice: "which switch fits my PoE devices", since its data
exists today.

## Access control

The site will be public. Reading is anonymous; changing shared data needs login
and a sufficient role. Login is not built now, but the code is shaped so that
adding it doesn't mean touching every handler.

Today the API has no authentication; Authelia in front of the service is the
only gate (see Security in DESIGN.md). That is fine for a private deployment
and not for a public one.

**Design to follow from the start:**

- **A permission, not a check.** Every route that writes declares the
  permission it needs (for example `overrides:write`, `watchlist:write`) at its
  registration, enforced by one middleware that reads a *principal* from the
  request context. Handlers never inspect headers themselves.
- **Principal source is pluggable.** Phase 0 provides a configured mode that
  treats every request as fully privileged (current behaviour, for private
  deployments). The next mode reads the identity Authelia forwards
  (`Remote-User`, `Remote-Groups`), trusted only when the request comes from
  the configured proxy. A later mode can be the app's own sessions if
  accounts for visitors are added.
- **Fail closed when public.** A config flag marks the deployment as public.
  When it is set and no principal source is configured, write routes refuse
  requests rather than falling back to the privileged mode.
- **Everything that mutates is gated**, including `POST /v1/items` (add a
  watched product), not only overrides.
- **Attribution from the beginning.** Overrides record who made them and a
  history of changes (append-only), so a public site can review and revert.
  This needs a schema addition (author, plus a history table), cheap to do
  before there is data worth migrating.
- **Roles.** Anonymous (read, local build plan), member (server-side build plan,
  saved searches, alerts), editor (overrides), admin (watch-list items,
  everything else).
- **Abuse limits.** Keep the same-origin check, JSON-only bodies and rate
  limits; add per-principal limits, and caching of read endpoints, once the site
  is public.
- **An interim option that needs no app code:** let the ingress/Authelia
  protect write methods and the editor route, leaving reads open.

## Order of work

Done: items 1, 2, 3, 4 and 5 below, plus the value sorts and the compare view from phases 2 and 5, and the browser-only part of the build plan (phase 4). (The data work's camera-bitrate experiments are still to do; the editor is where their findings go.)

1. Data work: AP coverage metric; start camera bitrate experiments (overrides).
2. Access seam: permission middleware, principal, config modes; override
   attribution and history.
3. Phase 1 (router, product pages).
4. Phase 2 (spec table, finder).
5. Phase 3 (override editor), once the seam exists.
6. Phase 4 (build plan, saved searches with alerts).
7. Phase 5 (compare, alternatives, rack planner).
8. Phase 6 (builder), one role at a time.

Phases 4-6 are sketched, not committed; they should be revisited once the
finder is in use.

## Open questions

- Delivery for alerts when visitors are public: per-user ntfy topic, email, or
  something else.
- How accounts are created, if at all, beyond whoever Authelia already knows.
- The usable-width rule for a 10" rack.
- The exact estimation model for camera bitrate, to be settled by
  experiment.
