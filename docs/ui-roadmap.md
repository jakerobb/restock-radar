# UI roadmap

What is not built yet. What exists is in [README.md](../README.md#web-ui) and
[DESIGN.md](../DESIGN.md); the access-control design is under Access control
there.

The goal is to turn the collected data into something people can use: find
products by what they must do, plan a system from them, and be told when they
are available.

## Principles

- **One requirement language.** A *requirement* ("has a 10GbE PoE+++ port",
  "6 GHz radio", "PoE budget >= 200 W", "fits a 10-inch rack") is the common
  currency. The finder takes requirements from the user, saved searches store
  them, and the system builder generates them.
- **Unknown is not false.** Matching has three outcomes: matches, doesn't match,
  can't tell. Products that can't be told are shown in their own group, never
  dropped silently.
- **Explain every answer.** A match says which port or radio satisfied which
  requirement; a recommendation says why it was chosen and what it assumed.
  Wrong advice costs more than a missing field.
- **Published values stay visible.** Wherever an override changes a value, the
  published value is shown beside it.
- **The browser filters; the API stays light.** The UI fetches the whole
  derived catalogue once and matches locally. A server-side `/v1/find` is added
  only if the builder or a non-browser client needs it.
- **Live price and stock is the edge.** Static design tools can't say "this
  build is in stock now for $X". Everything that recommends products shows
  current availability.

## Saved searches and alerts

A saved search is a set of requirements plus optional limits ("under $X", "in
stock"). It alerts through ntfy when a matching product becomes available or
drops below the limit, which extends the radar's job from a hand-picked watch
list to needs. It can also be a line in a build plan.

Alerts need to know where to send themselves, so they need accounts, and
signed-in users need their build plans stored on the server. Anonymous visitors
keep theirs in the browser. Per-user subscriptions are out of scope in
DESIGN.md until this is built, together with per-user ntfy topics or another
delivery channel.

## Alternatives

On the product page: cheaper or in-stock products with similar derived specs.

## Rack planner

Choose a 19" or 10" rack and a number of U; add products and shelves; the
planner sums heights and checks width and depth. 10" fit is a query-time check
against the sorted dimensions. Rack-mountable and shelf-mounted items are both
handled. Rack plans can be added to the build plan.

## System builder

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

The smallest useful first slice is "which switch fits my PoE devices", which
"Find a switch" already answers.

## Camera bitrate

The store publishes no camera bitrate, so the plan uses an estimate by
resolution class. Tuning it means checking against the UniFi capacity
calculator by hand and recording the findings as overrides (added metrics with
a `source_url`), so they are visible, editable and attributable.

## Access control for a public site

The permission and principal seam, the proxy-header mode, and override
attribution and history exist. A public site additionally needs:

- Visitor accounts, if any, as a further principal source, with a member role
  for server-side plans, saved searches and alerts.
- Per-principal rate limits and caching of read endpoints.
- Until then, the ingress or Authelia can protect write methods and the editor
  route and leave reads open.

## Open questions

- Delivery for alerts when visitors are public: per-user ntfy topic, email, or
  something else.
- How accounts are created, if at all, beyond whoever Authelia already knows.
- The usable-width rule for a 10" rack.
