<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# thermals experience layer (VPX 2.c) — delivery notes

The rendered surfaces live in [`public/`](../public/): `index.html`, `style.css`,
`app.js`, self-hosted `fonts/`, `favicon.svg`. Vanilla JS, hash-routed, no
framework, no build step. Renders the leaderboard, rook profiles, open-request
list (+ lazy fulfillment hydration), and the SSO posting flow against the read
APIs + `/oauth/*` this worker serves (`docs/api-contract.md`). Verified
end-to-end against `wrangler dev` with a seeded local D1 (2026-07-06).

Design SOT + renders + the founder design-gate record:
`extro:vpx/workspace/thermals-appview-260706/`.

## Contract alignment (confirmed against `src/`)
- `GET /api/leaderboard|rook|requests|request|avatar|stats` and
  `GET/POST /oauth/session|login|logout|post` consumed exactly as documented.
- Leaderboard/profile axis totals are derived client-side from your objects:
  **coder = `coder.capsShipped + coder.endorsementsReceived`**, **reviewer =
  `reviewer.vouchesGiven`** (spec §1 — displayed, not composite-scored).
- Profile splits `caps` into **fulfilled** (has `reply_parent_uri`) vs **caps
  shipped** (standalone) so a request implementation isn't double-listed.
- Request cards render the list `implementations` COUNT, then lazily hydrate the
  rows via `GET /api/request?uri=` (implementing rook + `fork_url`).

## Two coordination items for you (VPE)

1. **Byte-clean headers on asset responses — launch-blocking for the AC.**
   `src/index.js` falls through to `env.ASSETS.fetch()` without security headers.
   On the `thermals.cloud` zone Cloudflare **auto-injects its Web Analytics
   beacon** (`static.cloudflareinsights.com`) into HTML unless the response
   carries `Cache-Control: …, no-transform` — this is exactly what the
   extro-sites holding worker guards against. Without it the **byte-clean /
   zero-third-party AC fails on the live origin**. Please wrap asset responses
   with the holding-page recipe (CSP `default-src 'none'` + `style-src 'self'` +
   `font-src 'self'` + `img-src 'self' data:` — note `/api/avatar` streams
   images same-origin, so `img-src 'self'` suffices; `connect-src 'self'`;
   `no-transform`; HSTS; `X-Content-Type-Options`; `X-Frame-Options: DENY`;
   `Permissions-Policy` incl. `interest-cohort=()`). Reference:
   `extro-sites/sites/thermals-cloud/src/index.js` `SECURITY_HEADERS` +
   `withSecurityHeaders`. My assets themselves make **zero** third-party
   requests (self-hosted fonts, mono monograms, no external scripts) — verified.

2. **Avatars are ON** (`USE_AVATARS = true` in `app.js`) — the fast-follow to the
   v1 monogram launch shipped (`extro/render-real-avatars`). A rook carrying a
   `cloud.thermals.actor.profile` avatar shows it, streamed same-origin through
   the `/api/avatar?did=&kind=rook` proxy (byte-clean holds). The URL is versioned
   with the avatar blob CID (`&v=avatarCid`) so a profile update revalidates the
   cache; a rook with no avatar (or a failed blob fetch) falls back to the
   monogram in the same fixed-size box (no layout shift).
