---
name: restock-radar-debug
description: Investigate a problem with the deployed Restock Radar (not fetching, missing or wrong notifications, stale stock or price, a product not tracked, odd data). Use before touching the cluster, to pick the right way in.
---

# Debugging the deployed Restock Radar

Restock Radar runs in the homelab Talos cluster, namespace `restock-radar`,
deployment `restock-radar` (one replica, port 8080), image `FROM scratch`.

## What does not work

The container has **no shell, no `sqlite3`, no `curl`, no `tar`**. So:

- `kubectl exec ... -- sh` or `-- curl` fails.
- `kubectl cp` fails (it needs `tar` in the container).
- Don't spin up a second pod to mount the data PVC: it is ReadWriteOnce.

`kubectl exec` *can* run the app's own binary, since that needs no shell.

## Where to run things

`kubectl` is on the Talos jump box. Everything below is run there:

```bash
ssh jakerobb@rpi5-1.lan
```

(Key auth is set up; no need to ask.) The public hostname sits behind
Authelia, so from the jump box use `kubectl port-forward` instead:

```bash
kubectl -n restock-radar port-forward deploy/restock-radar 8080:8080 &
curl -s localhost:8080/v1/status
```

Reads need no permission, so this works without a login.

## First: does the image have the tools?

`query` and `/v1/debug/poller` shipped together. Check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/v1/debug/poller   # 200 = yes
```

On an older image `restock-radar query ...` is **not** a query: the binary
ignores it and starts a second server (syncing the config into the database
first). Don't run it unless that check gave 200. If it gave 404, use only the
logs, `/metrics` and the API below, or the last-resort section.

## Pick the question

| Question | Use |
|----------|-----|
| Is it running and polling at all? | `/health` (last poll time) and `/v1/debug/poller` |
| Why isn't it fetching, or why slowly? | `/v1/debug/poller`: `in_cycle` stuck for hours means hung; `backoff_factor` over 1 and `last_cycle_blocked` mean the store is rate limiting us |
| Which items are failing, and with what? | `/v1/debug/poller` → `failing` (consecutive count, last error, `result` as in `fetches_total`) |
| Blocked vs schema change vs outage over time | `/metrics`: `restock_radar_fetches_total{result}`, `restock_radar_last_success_timestamp_seconds` (also in SigNoz) |
| What happened in the process? | `kubectl -n restock-radar logs deploy/restock-radar --since=1h` (JSON lines; `jq` isn't in the container but is on the jump box) |
| How fresh is each region, what's overdue? | `/v1/status` → `by_region` |
| Did a price or stock change, and when? | `/v1/events?region=us&since=<id>&limit=...`, `/v1/history?days=30`, `/v1/variants?region=us` |
| A product's specs, overrides, derived facts | `/v1/products/{region}/{slug}/specs`, `/v1/overrides?slug=...`, `/v1/derived?region=` |
| Is a notification stuck? | `/v1/status` (`pending_events`, `failed_events`), or SQL on `events` (`notified_at` is NULL until sent) |
| Anything else about the data | SQL, below |

Note `/v1/debug/poller` is in-memory: it starts empty after a restart, so
"nothing failing" right after a restart means little. Logs and the database
cover earlier history.

## SQL

Read-only; it can't change anything and doesn't stop the poller:

```bash
kubectl -n restock-radar exec deploy/restock-radar -- /restock-radar query --schema
kubectl -n restock-radar exec deploy/restock-radar -- /restock-radar query \
  "SELECT * FROM events ORDER BY id DESC LIMIT 20"
```

- Flags go before the statement: `--json` for JSON, `--limit N` (default 1000,
  0 for all), `-` to read the statement from stdin.
- Output is tab-separated with a header line; `NULL` is written as `NULL`.
- Run `--schema` first rather than guessing table or column names.
- Times are TEXT (e.g. `events.ts`), so compare them as strings, or with SQLite's `datetime()`.

## Last resort: a throwaway debug container

Only if the above can't answer it (or the image is too old). Attach an
ephemeral container to the pod rather than starting a second pod; with
`--target` it shares the process namespace, so the data is under
`/proc/1/root`:

```bash
kubectl -n restock-radar debug deploy/restock-radar -it \
  --image=keinos/sqlite3 --target=restock-radar -- sh
# then:  sqlite3 -readonly /proc/1/root/data/restock-radar.db
```

Open the database read-only. Ephemeral containers can't be removed; they go
away with the pod. If this had to be used, say what was missing and consider
whether `query` or `/v1/debug/poller` should grow to cover it.
