# Public read-only site via static snapshots: implementation plan

Status: draft. Nothing here is built.

## Decisions

- **Hosting: Cloudflare R2**, S3 API, with Cloudflare serving it on a custom
  domain.
- **Excluded from the public snapshot:** override notes, source URLs and
  reasons, `created_by`/`updated_by`, and override history. Effective values
  (the published value beside an overridden one) are public.
- **Public redistribution is not a concern.** The site shows no Ubiquiti
  imagery, earns nothing, and helps customers buy the right products. This is
  settled; if it ever becomes commercial, revisit.

## Goal

Serve restock-radar to the public without exposing the home LAN and without
moving the database off it. The database and poller stay at home. After each
poll cycle (and after an override change) the server publishes a snapshot of
the read-only API as static JSON, plus the web UI, to S3-compatible object
storage behind a CDN. Public visitors never reach the LAN or the Go server.

This keeps the DESIGN.md rule that the server is the single poller: public
traffic scales with the CDN, never with requests to the UniFi store.

## Why this fits the existing code

- The UI already works on whole-dataset snapshots (`getProducts`, `getDerived`,
  `getHistory`, `getStatus`) and searches and sorts client-side.
- SQLite, the poller and `dbcopy` backups are unchanged.
- Losing the bucket loses nothing: the next publish regenerates it.

## Scope

In: read-only public site, snapshot generation, upload, UI read-only mode,
public-field allowlist, config, metrics, tests.

Out (stays private, LAN only): `POST /v1/items`, `PUT`/`DELETE /v1/overrides`,
`GET /v1/overrides/history`, `POST .../refresh`, `/metrics`, `/health`,
`/v1/me`. Per-user wish lists and saved-search alerts (see
[ui-roadmap.md](ui-roadmap.md)) need accounts and writes and can't be static;
if they ship publicly they need a small stateful service alongside the static
data.

## Design

### 1. Snapshot content

Each file is the same JSON the live handler returns today. The publisher calls
the existing handlers through `httptest.ResponseRecorder` with a synthetic
anonymous request, so the static output can't drift from the live API and the
SPA needs no new response shapes.

| File | Source | Notes |
|------|--------|-------|
| `v1/products.json` | `GET /v1/products` | |
| `v1/derived.json` | `GET /v1/derived` | |
| `v1/status.json` | `GET /v1/status` | |
| `v1/variants.json`, `v1/variants/{region}.json` | `GET /v1/variants` | one per configured region |
| `v1/history-30.json`, `-90`, `-365` | `GET /v1/history?days=` | fixed windows only |
| `v1/events-recent.json` | `GET /v1/events?limit=N` | recent N; the `since` cursor feed isn't public |
| `v1/products/{region}/{slug}/specs.json` | `GET .../specs` | one per product |
| `v1/meta.json` | new | `generated_at`, `last_poll`, snapshot id, schema version |
| UI assets | `ui/dist` | content-hashed names, published once per release |

Open point: the UI calls `/v1/history?days=N` with a user-chosen N. Either the
public build maps N to the nearest fixed window, or offers only those windows.

### 2. Atomicity: versioned prefix and a pointer

Single-object PUTs are atomic; sets of objects aren't. So:

1. Write all data files under `snap/<snapshot-id>/v1/...` (id = UTC timestamp).
2. Write `latest.json` (`{"snapshot":"<id>","generated_at":...}`) last.
3. The public UI reads `latest.json` first (short TTL, `max-age=30`) and then
   fetches everything from `snap/<id>/...` (`immutable`, long TTL).
4. Prune snapshots older than the newest N after a successful publish.

A reader mid-publish sees either the old pointer or the new one, never a mix.
Fallback if this proves heavy: overwrite fixed names with a short TTL and
accept brief skew between `products` and `derived`.

Hash-skip: keep the previous manifest (path to content hash). Files whose hash
is unchanged are not re-uploaded; the new snapshot's manifest lists them under
their existing keys. Per-product spec files use `products.specs_hash` as the
change signal. This keeps most publishes down to a handful of small objects.

### 3. Public-field allowlist (the real security work)

A snapshot is public by definition, so build it from an allowlist, not by
redacting the private view.

- The publisher runs requests as an anonymous principal and then passes each
  document through a typed export step that copies only listed fields.
- Override notes, source URLs and reasons, `created_by`/`updated_by`, and
  override history are excluded (decided). Effective values (published value
  beside the overridden one) are public.
- A test asserts that no snapshot contains email addresses, actor names, or
  keys outside the allowlist, so adding a field to a handler can't leak it.

### 4. Publisher package: `internal/publish`

- `Publisher` with `Publish(ctx)`: build snapshot into a temp dir, diff against
  the last manifest, upload changed objects, write the pointer, prune.
- Storage behind a small interface (`Put`, `Delete`, `List`) with an
  S3-compatible implementation (minio-go or the AWS SDK; use the latest stable
  release) and a filesystem implementation for tests and local preview.
- Triggers: after a completed poll cycle; after an override create, update or
  delete (debounced a few seconds); at startup if the last publish is older
  than the interval. Coalesce overlapping triggers into one pending publish.
- Failure handling follows `dbcopy`: log, retry on a backoff, never block the
  poller. A failed publish leaves the old snapshot serving.
- Credentials come from env interpolation like the existing config; use a
  bucket-scoped key with write access only to that bucket.

### 5. Config

New `publish:` section: `enabled`, `endpoint`, `region`, `bucket`, `prefix`,
`keep_snapshots`, `public_base_url`, credentials via `${ENV}`. Validation
refuses `enabled: true` with missing fields.

### 6. UI read-only mode

- Build-time flag (`VITE_PUBLIC=1`) producing a second build whose API base is
  the CDN: read `latest.json`, then fetch from the snapshot prefix.
- Hide every write control (add item, override editor, refresh) and skip
  `getMe`. Show "data as of <generated_at>" from `meta.json`.
- The LAN build is unchanged and keeps the full API.
- Dockerfile gets a second UI build stage (or a script) producing the public
  bundle; publish it with the data on release.

### 7. Hosting

Cloudflare R2, public through a custom domain.

- **Cost** (from Cloudflare's pricing docs, checked November 2026; recheck
  before launch): internet egress is free. The monthly free tier is 10 GB of
  storage, 1M Class A (writes, lists) and 10M Class B (reads) operations;
  beyond it, $0.015/GB-month, $4.50 per million Class A, $0.36 per million
  Class B. Deletes are free. This workload should stay inside the free tier:
  hash-skip keeps a publish to a handful of PUTs, and reads are served from
  Cloudflare's cache.
- **Avoid `ListObjects`** (Class A): track objects with the manifest instead of
  listing the bucket, and use deletes (free) for pruning.
- **S3 client config:** endpoint `https://<account-id>.r2.cloudflarestorage.com`,
  region `auto`, path-style where the SDK needs it. Use an R2 API token scoped
  to this one bucket with object read/write.
- **Serving:** attach a custom domain to the bucket (not the `r2.dev` URL,
  which is for development and is rate limited). The domain's DNS must be on
  Cloudflare. Confirm in the R2 docs how custom-domain requests interact with
  the cache; I haven't verified it.
- **Caching:** `Cache-Control: public, max-age=30` on `latest.json`, and
  `public, max-age=31536000, immutable` on everything under `snap/<id>/` and
  on hashed UI assets. If the pointer needs to be fresher than its TTL, purge
  that one URL after publishing.
- **Headers:** the live server sets CSP and the other security headers in
  `securityHeaders`; there's no Go middleware in front of static files, so set
  equivalent response headers with a Cloudflare Transform Rule (or Worker) on
  the domain.
- CORS isn't needed if the UI and data share an origin.

### 8. Observability

Metrics: `publish_last_success_timestamp_seconds`, `publish_total{result}`,
`publish_objects_uploaded`, `publish_duration_seconds`. Alert on "no
successful publish for an hour", mirroring the existing fetch alert.

## Implementation order

1. `internal/publish`: filesystem storage, handler-driven snapshot builder,
   manifest and hash-skip. Tests: output equals live handler output; unchanged
   data uploads nothing; pointer written last.
2. Allowlist export step and the leak test.
3. S3 storage implementation; config section and validation; wire into
   `cmd/main.go` after poll cycles and override changes.
4. Metrics and alert rule.
5. UI public build and read-only mode; `meta.json` freshness display.
6. Hosting: bucket, CDN, domain, headers; end-to-end check with a preview
   bucket before pointing real DNS at it.
7. Docs: DESIGN.md section and update README/ops notes.

Steps 1-2 are independently useful (they give a local static preview) and can
land first.

## Risks and open questions

- **Ubiquiti tolerance** stays the open question in DESIGN.md, but the static
  tier doesn't worsen it: only the one poller ever calls the store, however
  many people visit.
- **Freshness.** Visitors see data up to poll interval + publish time + CDN
  TTL old. Keep the pointer TTL short and show the timestamp.
- **Object count.** Per-product spec files may mean thousands of small objects;
  hash-skip keeps writes low but lists and prunes need paging.
- **History file size.** A 365-day history grows with events; check compressed
  size and serve gzip/brotli.
- **Dynamic features.** Anything needing per-user state is out of reach for the
  static tier (see Scope).
- **UI `history?days=`.** Fixed windows change the public UX slightly.
