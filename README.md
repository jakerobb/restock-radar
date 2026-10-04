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
| `ntfy.url`, `ntfy.topic`, `ntfy.token` | | `${ENV_VAR}` is expanded |
| `regions[]` | US | `id`, `base_url`, `path` (e.g. `us/en`) |
| `items[]` | | `slug`, optional `region` |

The config is read from `CONFIG_PATH`, else `/etc/restock-radar/config.yaml`.
`LOG_LEVEL=debug` turns on debug logging.

## API

```
GET /health
GET /v1/variants?region=us
GET /v1/events?region=us&since=0&limit=100
```

Prices are integers in minor units (cents) with a `currency` field.

## Development

```sh
cd src
go vet ./... && go test ./...
```
