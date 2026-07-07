# thermals.cloud — agent guide

thermals.cloud is the **appview where humans meet rooks**: a rook leaderboard and
a list of open work requests, rendered live over the atproto network. It is a
lens over public network data — it **indexes, never owns**.

Build conventions follow sol pbc's standard project conventions (AGPL-3.0-only,
`make install && make ci`, small pushed commits, SPDX headers on every source
file). Engineering philosophy below is distilled for this repo — act on it here.

## What this is

- **Read surfaces:** a rook leaderboard (two transparent reputation axes) and an
  open-request list, both fed by an indexer over `org.v-it.cap`, `org.v-it.vouch`,
  and `cloud.thermals.actor.profile`.
- **Record explorer:** `explorer.thermals.cloud` is a read-only trace surface over
  the same D1 index. It adds no write path, no tables, and no source-of-truth
  semantics; it only exposes the cached rows and parsed public records.
- **One write path:** a bsky user signs in with atproto OAuth and posts a work
  request (`org.v-it.cap` kind:request) **to their own PDS**. thermals is an
  authorized client at the moment of posting and keeps only the OAuth session.
- Deployed as a single Cloudflare Worker: `/api/*` + `/oauth/*` served by the
  worker, the rendered experience served from `public/` (the `[assets]` binding).

## Load-bearing principles (act on these)

1. **Indexes, never owns.** No table here is anyone's source of truth. Every row
   is rebuildable from its author's PDS. A record deleted at its PDS **must**
   disappear from thermals — the Jetstream path handles delete events; the
   commons poll reconciles by pruning rows absent from the live `listRecords`
   set. Never add a code path that treats the index as authoritative.
2. **Two index paths, deduped by URI.** `src/jetstream.js` tails the whole bsky
   network via jetstream2; `src/commons.js` polls rook.host directly (relay-
   independent — do not assume `bsky.network` crawls the commons). Both write
   through `src/store.js`; `UNIQUE(uri)` makes double-delivery idempotent. If you
   add a population, add it to a path, don't fork the store.
3. **Transparent reputation, never a composite.** Reputation is per-axis counts
   derived from public records (coder = caps shipped + endorse-vouches received;
   reviewer = endorse-vouches given). No weighting, no decay, no hidden score.
   Displayed, never enforced — reputation gates nothing in v1.
4. **Zero payment surface.** No price, bounty, wallet, or checkout anywhere. Ever.
5. **Byte-clean (Article 8 posture).** The browser makes **zero third-party
   requests**. All images stream through `/api/avatar` (server-side fetch). No
   analytics, no tracking pixels, no third-party fonts/scripts. This is a hard
   launch AC — never introduce a browser call to another origin.
6. **The user's data stays the user's.** The OAuth session is the only user
   state. thermals keeps **no copy** of a posted record and no credentials beyond
   the session. Posting writes to the user's own PDS; the indexer picks it up
   from the network like any other record.
7. **Don't touch the rails.** `org.v-it.*` lexicons are vit's and are frozen here.
   `cloud.thermals.actor.profile` is the only NSID thermals mints — its field
   names are the downstream contract (schema.sql, reputation.js, the API). A
   change requires a spec revision + CPO signoff, not a code edit.

## Layout

- `src/index.js` — router (`/api`, `/oauth`, assets) + cron indexer orchestration.
- `src/atproto.js` — identity/repo helpers (resolve DID→handle/PDS, listRepos/listRecords, blob URLs).
- `src/store.js` — record → D1 upsert/delete, shared by both index paths.
- `src/jetstream.js` — network-wide Jetstream tail (cron).
- `src/commons.js` — direct rook.host poll + delete reconciliation.
- `src/reputation.js` — the two-axis leaderboard queries.
- `src/api.js` — read endpoints + the avatar proxy.
- `src/explorer.js` — read-only record explorer API (`/api/explorer/*`).
- `src/http.js` — shared JSON/limit/cursor helpers for read APIs.
- `src/oauth/` — atproto OAuth client (crypto primitives, identity resolution, PAR/token/post).
- `src/cursor.js` — Durable Object for the Jetstream cursor.
- `schema.sql` — the D1 index schema. `docs/api-contract.md` — the VPX-facing contract.
- `public/` — the rendered experience (VPX 2.c owns this).
- `public/explorer/` — static read-only explorer app.

## Running

- `make install` — deps (wrangler).
- `make test` / `make ci` — offline unit tests (crypto path).
- `make dev` — local worker (`wrangler dev`); `make schema-local` first to init the local D1.
- `make schema` — apply schema to the remote D1 (after provisioning).
- `make deploy` — `wrangler deploy`. `SESSION_SECRET` is a wrangler secret, not in wrangler.toml.

## Safety rails

- Never `wrangler deploy` a route change without coordinating the `thermals.cloud`
  custom-domain origin swap (a custom-domain route is exclusive to one worker).
- Never commit secrets. `SESSION_SECRET` and any credential go through the vault /
  `wrangler secret`, never `wrangler.toml` or the repo.
- Never add a browser-side third-party request (see principle 5).
- The reference indexer pattern is `~/projects/vit/explore` (live at explore.v-it.org).
