# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/jakerobb/restock-radar/security/advisories/new)
for this repository, not in a public issue. Include what you found, how to
reproduce it, and what you think the impact is.

This is a personal project, so there is no formal response time, but reports
are read and taken seriously.

## What the service does and doesn't protect

Restock Radar is built to run inside a home network, behind an authenticating
reverse proxy:

- **It has no login of its own.** By default (`auth.mode: open`) anything that
  can reach the HTTP port can read the watch list, add products and correct
  specs, so don't expose it directly to the internet. To make it reachable by
  people you don't know, put it behind an authenticating proxy and set
  `auth.mode: proxy`: the service then believes the identity headers only of
  requests from `trusted_proxies`, and only users in a configured group may
  change anything (see "Access control" in the README). Reading stays open, and
  who made each correction is shown only to those who may review them. A
  misconfiguration leaves nobody able to change anything, not everybody.
- **It only talks to the stores you configure** (by default `store.ui.com`),
  to your ntfy server, and to `techspecs.ui.com`, where it sends a `HEAD`
  request for the product pages it links to (a few a cycle; the host is fixed
  and not configurable). A product slug or URL submitted through the UI can only
  select a product on a configured store.
- **Adding a product is rate limited** and the watch list is capped
  (`max_items`), because each addition makes the server call the store.
- **State is a SQLite file.** Back it up with `backup_dir`; see the README.

## Supported versions

Only the latest published image is supported.
