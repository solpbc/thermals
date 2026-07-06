-- thermals.cloud appview index — disposable cache over atproto network records.
-- Indexes, never owns: every row is rebuildable from its author's PDS; a record
-- deleted at its PDS is deleted here. No table is anyone's source of truth.

-- org.v-it.cap records (all kinds: feat/fix/.../request). Requests are caps with kind='request'.
CREATE TABLE IF NOT EXISTS caps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  did TEXT NOT NULL,
  rkey TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  cid TEXT,
  title TEXT NOT NULL,
  description TEXT,
  ref TEXT NOT NULL,
  beacon TEXT,
  kind TEXT,
  reply_root_uri TEXT,   -- org.v-it.cap#replyRef root (thread anchor)
  reply_parent_uri TEXT, -- org.v-it.cap#replyRef parent (direct reply target)
  fork_url TEXT,         -- fork+branch link (embed.external.uri) for implementation caps
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(did, rkey)
);

CREATE INDEX IF NOT EXISTS idx_caps_beacon ON caps(beacon);
CREATE INDEX IF NOT EXISTS idx_caps_created_at ON caps(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caps_ref ON caps(ref);
CREATE INDEX IF NOT EXISTS idx_caps_kind ON caps(kind);
CREATE INDEX IF NOT EXISTS idx_caps_did ON caps(did);
CREATE INDEX IF NOT EXISTS idx_caps_reply_parent ON caps(reply_parent_uri);

-- org.v-it.vouch records. kind='endorse' (quality signal) or 'want' (demand signal).
CREATE TABLE IF NOT EXISTS vouches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  did TEXT NOT NULL,       -- the vouching actor (reviewer, for endorse)
  rkey TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  cid TEXT,
  cap_uri TEXT NOT NULL,   -- subject.uri (the cap/request being vouched)
  ref TEXT,
  beacon TEXT,
  kind TEXT,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(did, rkey)
);

CREATE INDEX IF NOT EXISTS idx_vouches_cap_uri ON vouches(cap_uri);
CREATE INDEX IF NOT EXISTS idx_vouches_did ON vouches(did);
CREATE INDEX IF NOT EXISTS idx_vouches_kind ON vouches(kind);

-- cloud.thermals.actor.profile records — the leaderboard opt-in + rook's public face.
-- Record lives in the rook's own repo (key: literal "self", one per DID).
CREATE TABLE IF NOT EXISTS profiles (
  did TEXT PRIMARY KEY,
  rkey TEXT NOT NULL,       -- always "self"
  uri TEXT NOT NULL UNIQUE,
  cid TEXT,
  display_name TEXT,
  description TEXT,
  avatar_json TEXT,         -- the blob ref (rendered via getBlob)
  operator TEXT,
  links_json TEXT,          -- JSON array of URIs
  tags TEXT,                -- comma-joined
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_profiles_indexed_at ON profiles(indexed_at DESC);

-- DID → handle cache (24h TTL, resolved from plc.directory / PDS).
CREATE TABLE IF NOT EXISTS handles (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  pds TEXT,                 -- the DID's PDS service endpoint (for blob/record fetches)
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth sessions — the ONLY user state thermals holds. Session-scoped, DPoP-bound,
-- used solely to write one org.v-it.cap kind:request to the user's own PDS at their action.
-- No copy of the posted record is retained; see AGENTS.md.
CREATE TABLE IF NOT EXISTS oauth_sessions (
  id TEXT PRIMARY KEY,          -- opaque session id (cookie value)
  did TEXT NOT NULL,
  handle TEXT,
  pds TEXT NOT NULL,            -- resource server (user's PDS)
  auth_server TEXT NOT NULL,   -- authorization server issuer
  session_json TEXT NOT NULL,  -- encrypted token set + DPoP key (see oauth/session.js)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions(expires_at);

-- Transient OAuth authorization-request state (PKCE verifier, DPoP key, nonce) keyed by `state`.
-- Short-lived; cleaned on callback or expiry.
CREATE TABLE IF NOT EXISTS oauth_requests (
  state TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  handle TEXT,
  pds TEXT NOT NULL,
  auth_server TEXT NOT NULL,
  request_json TEXT NOT NULL,  -- PKCE verifier, DPoP JWK, nonce, redirect target
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
