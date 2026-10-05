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

- **It has no login of its own.** Anything that can reach the HTTP port can
  read the watch list and add products. Don't expose it directly to the
  internet; put it behind something that authenticates users.
- **It only talks to the stores you configure** (by default `store.ui.com`) and
  to your ntfy server. A product slug or URL submitted through the UI can only
  select a product on a configured store.
- **Adding a product is rate limited** and the watch list is capped
  (`max_items`), because each addition makes the server call the store.
- **State is a SQLite file.** Back it up with `backup_dir`; see the README.

## Supported versions

Only the latest published image is supported.
