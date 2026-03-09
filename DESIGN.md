# RestockRadar — Design & Architecture Document

> **Status:** Pre-development. This document captures design decisions made before coding began.  
> **Last updated:** March 2026

---

## Overview

RestockRadar is a mobile app (iOS-first, Android to follow) that sends push notifications when Ubiquiti/UniFi products come back in stock at the official UI.com store. Ubiquiti sells exclusively through its own storefront with no Amazon/retail fallback, making stock monitoring a genuine pain point for their enthusiast community. First-party email alerts are unreliable and frequently never sent at all.

The app is intentionally simple on the client side — its primary job is to receive push notifications and let users manage their subscriptions. All the real work happens server-side.

---

## Goals & Non-Goals

**Goals:**
- Fast, reliable push notifications when a watched product comes in stock
- Push notification to dismiss when product goes back out of stock (enabling Live Activities)
- Historical timeline of stock events per product
- Trend detection — surface patterns like "tends to restock Tuesday mornings"
- Regional store support
- No accounts, no user data stored server-side
- Tip jar monetization (optional, non-intrusive)

**Non-Goals (v1):**
- Android (planned for v2)
- Stores beyond Ubiquiti
- Price tracking
- Any form of automated purchasing

---

## Name

**RestockRadar** — descriptive, searchable, not tied to Ubiquiti's trademarks, and has legs if the app expands to other manufacturers.

Avoid anything incorporating "UI", "UniFi", or "Ubiquiti" in the app name or logo. Ubiquiti's trademark guidelines explicitly prohibit using their marks as part of a third-party product name.

---

## Architecture

```
UI.com store pages
        │
        ▼
 ChangeDetection.io  ──(webhook)──▶  Companion Server (Node/Python)
  (self-hosted,                             │
   Linode)                                  ├──▶ Postgres (event log)
                                            │
                                            ├──▶ APNs  ──▶ iOS devices
                                            │
                                            └──▶ FCM   ──▶ Android devices
```

### Components

**ChangeDetection.io** (new, Linode)
- Monitors each product+region URL for stock status changes
- Configured with the `restock_diff` processor, `in_stock_processing: "all_changes"` so it fires on both in-stock and out-of-stock transitions
- Fires a webhook to the companion server on any change
- Managed via its REST API (`/api/v1/watch`) — no manual setup needed

**Companion Server** (new, Linode)
- Receives ChangeDetection webhooks
- Looks up which product+region changed
- Writes event to Postgres (timestamp, product, region, status)
- Fans out push notifications to all device tokens subscribed to that product+region
- Handles APNs (iOS) and FCM (Android) delivery
- Manages device token registration/deregistration
- Applies anti-scalper jitter before sending

**Postgres** (existing on Linode)
- `stock_events` table: product, region, status (in/out), timestamp
- `device_subscriptions` table: device_token, platform (apns/fcm), product_id, region — no PII, no user identity
- Powers the historical timeline and trend features in the app

**ntfy** (new)
- Used for *internal* notifications only (server health, errors, etc.)
- Not used for end-user delivery — native APNs/FCM only for that

---

## Push Notifications

### iOS — APNs
- HTTP/2 REST API, works fine from Linux
- One request per device token; pipeline over a persistent connection
- No hard rate limits at hundreds-of-users scale
- Token auth via `.p8` key file (preferred over certificate-based)
- Payload limit: 4KB
- Priority: use `apns-priority: 10` (immediate) for in-stock alerts

### Android — FCM
- Firebase Admin SDK (Node.js or Python)
- Batch sends up to 500 tokens per call — efficient for fan-out
- Topic messaging as an alternative, but per-token batching is cleaner given no server-side user accounts
- FCM is free with no meaningful rate limits at this scale

### Live Activities (iOS — optional feature, opt-in)
- Start a Live Activity when a product comes in stock
- Acts as a persistent "still available" banner on the lock screen
- Server sends a follow-up APNs push to terminate the Live Activity when the product goes out of stock again
- This solves the "notification was buried" problem — users who miss the initial push still see the Live Activity
- Use `apns-push-type: liveactivity` for update/end pushes

---

## Watching Strategy

The set of monitored URLs is small and static (~50–150 SKUs × regions). There is **no per-user watch management** in ChangeDetection — every subscriber to "US - UniFi Travel Router" watches the same URL.

**Bootstrap script** (run once at setup, re-run to add products):
- Reads a canonical product+region list from config or Postgres
- Calls `GET /api/v1/watch` to fetch existing watches
- Diffs against the canonical list
- POSTs missing watches via `POST /api/v1/watch` with appropriate restock processor config
- Idempotent — safe to re-run

**Adding new products:** Update the canonical list, re-run bootstrap script.

**ChangeDetection API auth:** `x-api-key` header, key stored in environment variable on companion server.

---

## Regional Stores

Ubiquiti operates the following distinct storefronts. Stock does **not** sync across regions.

| Region | URL pattern | Notes |
|--------|-------------|-------|
| United States | `store.ui.com/us/en` | Primary market |
| Canada | `ca.shop.ui.com` | |
| Mexico | `store.ui.com/mx` | Underserved, worth supporting |
| United Kingdom | `store.ui.com/gb/en` | Post-Brexit, separate from EU |
| European Union | `store.ui.com/eu` | ~20 countries; verify if stock is truly shared or per-country |
| Australia | `aus.store.ui.com` | |
| Japan | `jp.store.ui.com` | |
| Taiwan | `tw.store.ui.com` | |
| China | `store.ui.com.cn` | Separate domain, different SKUs — punt to v2 or never |

**EU note:** The ~20 EU country storefronts may share a single inventory pool. Verify this empirically before deciding whether to monitor per-country or treat as one region. If they're independent, Germany vs. France etc. may matter to users.

**v1 scope:** US, UK, EU (as one region pending verification), Canada. Expand from there.

---

## No Accounts / Privacy Design

**There are no user accounts.** This is a deliberate design decision.

- Device tokens are the unit of identity server-side
- Subscription lists live **on device only** — the server only knows "this token wants alerts for product X in region Y"
- No email addresses, no names, no passwords, no login flow
- No GDPR/CCPA surface area beyond server logs
- No "delete my account" support burden
- No data breach liability for user PII

**Implications:**
- Cross-device sync: not supported in v1. Could add iCloud sync via CloudKit later (no server involvement)
- If user deletes app, their token eventually gets pruned when APNs/FCM returns an error for it
- "Did you get it?" confirmation is anonymous aggregate data only — that's fine, we don't need to know *who* got it

---

## Anti-Scalper Measures

These raise the friction for automated purchasers without meaningfully impacting legitimate users:

1. **Notification jitter:** Add a random 0–90 second delay per recipient before sending. A legitimate buyer has to navigate to checkout anyway; a bot firing 200ms after the push is broken by noise. Can be marketed as a "fairness delay."

2. **Rate limiting per token:** Cap at 2 alerts per product per token per 24-hour window. A real buyer needs one notification.

3. **No add-to-cart deep links:** Link to the product page only, not directly to a cart action. Two extra taps hurt bots more than humans.

4. **New token cooldown:** Don't send notifications to tokens registered in the last 24 hours. Scalpers spin up accounts in bulk; legitimate users don't.

5. **DeviceCheck, App Attest, and Play Integrity API:** On first use and on cert expiry, mobile apps will use first-party device authentication systems to verify app authenticity before establishing an mTLS client certificate; server APIs wil require mTLS.

**Honest assessment:** A determined scalper with a jailbroken client or direct API access can work around all of this. The goal is to make the app *more* fair for regular customers, not to be a scalper-proof fortress.

---

## "Did You Get It?" Feature

After an in-stock notification fires, prompt the user (via a notification action or in-app prompt) with a simple "Did you get it?" button.

- **Yes:** Auto-unsubscribe from that product+region alert. Optionally show tip jar prompt at this exact moment — highest conversion opportunity.
- **No / Dismiss:** Keep subscription active.

This also integrates naturally with Live Activities — dismissing the Live Activity is another natural moment to capture this signal.

Server receives an anonymous boolean event (got it: yes/no, product, region, timestamp). Powers the aggregate success metrics that feed trend detection.

---

## Historical Timeline & Trend Features

Every stock status change is written to Postgres with a timestamp. The app can query this to show:

- Per-product stock history timeline
- "Back in stock X times in the last 30 days"
- Day-of-week and time-of-day heatmaps ("tends to restock Tuesday mornings ~10am ET")
- "Back in stock confidence" score — how competitive is this product when it appears?

This is a genuine differentiator vs. web-based competitors (notify-me.rs, PageCrawl.io) who don't surface historical data in a mobile-native format.

---

## Monetization

**Tip jar** — in-app purchase, entirely optional. Key considerations:

- Apple takes 30% (15% for small developers under App Store Small Business Program)
- Best conversion moment: immediately after "Did you get it? → Yes"
- A "Supporter" one-time unlock may convert better than a pure tip jar (feels like a transaction, not a donation)
- Expectation-set: tip jar conversion rates are low (low single-digit % at best), but the emotional trigger here (just saved $200+ on gear you'd been hunting for weeks) is stronger than most apps

---

## Competitive Landscape

| Service | Delivery | Mobile app | History/trends | Notes |
|---------|----------|------------|----------------|-------|
| Ubiquiti first-party | Email only | No | No | Slow, unreliable, frequently silent |
| notify-me.rs | Email, Telegram, Discord | No | No | Web only |
| PageCrawl.io | Telegram, web push | No | No | Generic tool, Ubiquiti marketing page |
| **RestockRadar** | Native push, Live Activities | **Yes** | **Yes** | Only native mobile app in this space |

---

## Expansion Roadmap

**v1:** iOS, US region only (architecture is region-aware from the jump; we just won't be using it) 
**v2:** iOS Live Activities
**v3:** Android, additional regions

---

## Known Risks & Open Questions

- **Cloudflare blocking:** ui.com is likely behind Cloudflare. Aggressive polling from a single IP could get rate-limited or blocked. Keep ChangeDetection check intervals at 2–5 minutes minimum. Monitor for 403/429 responses.
- **EU store fragmentation:** Verify empirically whether EU country stores share inventory before deciding monitoring strategy.
- **ChangeDetection restock processor accuracy:** The `restock_diff` processor needs to correctly parse Ubiquiti's stock status markup. Validate against known in-stock and out-of-stock pages before launch.
- **APNs token lifecycle:** Tokens change on reinstall or OS update. Process APNs error responses diligently and prune dead tokens from Postgres.
- **App Store tip jar policy:** Review Guideline 3.1.1 before finalizing monetization approach.
- **Live Activities complexity:** iOS Live Activities require ActivityKit and a specific push payload format. This is an opt-in feature — don't let it block v1 launch.

---

## Tech stack

- **Docker+Kubernetes:** For server packaging and deployment (Linode Kubernetes Engine)
- **GitHub Actions:** For CI/CD
- **PostgreSQL:** For server data storage (device tokens, and tracked products, current and historical inventory status)
- **ChangeDetection.io:** container deployed to LKE to perform periodic checks
- **Go:** Server process in Go for high performance with minimal resource footprint
- **Swift/SwiftUI:** iOS app in the relevant state of the art
- **Kotlin:** Android app in the relevant state of the art
