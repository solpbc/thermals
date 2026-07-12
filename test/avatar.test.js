// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import worker from '../src/index.js';
import { handleApi } from '../src/api.js';
import { leaderboard } from '../src/reputation.js';
import { upsertProfile } from '../src/store.js';
import { openTestDb } from './helpers/d1.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A well-formed atproto blob ref, as stored in profiles.avatar_json.
function blobRef(cid, mime = 'image/png') {
  return { $type: 'blob', ref: { $link: cid }, mimeType: mime, size: 1024 };
}

// Seed a handle row whose cache is fresh against the DB clock, so resolveDid
// returns { handle, pds } without any network fetch.
function seedFreshHandle(db, did, pds) {
  db.DB.prepare(
    `INSERT INTO handles (did, handle, pds, fetched_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, pds = excluded.pds, fetched_at = excluded.fetched_at`,
  ).bind(did, `${did.slice(-4)}.rook.host`, pds).run();
}

// Install a fake global fetch that records every outbound URL. The handler maps
// a URL → Response (or throws for unexpected calls). Returns { calls, restore }.
function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function api(path, env) {
  const res = await handleApi(new Request(`https://thermals.cloud${path}`), env);
  return res;
}

test('avatar proxy (kind=rook) fetches the blob server-side and streams it', async () => {
  const db = openTestDb();
  const did = 'did:plc:rookavatar';
  const pds = 'https://rook.host';
  const cid = 'bafyavatarcid1';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  seedFreshHandle(db, did, pds);
  db.seedProfile({ did, display_name: 'avatar rook', avatar_json: JSON.stringify(blobRef(cid)) });

  const fx = stubFetch((url) => {
    // The only outbound call is the server-side getBlob against the owning PDS.
    assert.ok(url.startsWith(`${pds}/xrpc/com.atproto.sync.getBlob`), `unexpected fetch: ${url}`);
    assert.ok(url.includes(`did=${encodeURIComponent(did)}`));
    assert.ok(url.includes(`cid=${encodeURIComponent(cid)}`));
    return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
  });
  try {
    const res = await api(`/api/avatar?did=${encodeURIComponent(did)}&kind=rook&v=${cid}`, db);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    // Versioned (content-addressed) URL → immutable, hard-cacheable.
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=86400, immutable');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(bytes, png);
    // Exactly one server-side fetch — the browser makes zero third-party calls.
    assert.equal(fx.calls.length, 1);
  } finally {
    fx.restore();
    db.close();
  }
});

test('avatar proxy uses bounded (non-immutable) TTL when unversioned', async () => {
  const db = openTestDb();
  const did = 'did:plc:rookavatar2';
  seedFreshHandle(db, did, 'https://rook.host');
  db.seedProfile({ did, avatar_json: JSON.stringify(blobRef('bafyavatarcid2')) });

  const fx = stubFetch(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/webp' } }));
  try {
    const res = await api(`/api/avatar?did=${encodeURIComponent(did)}&kind=rook`, db);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
  } finally {
    fx.restore();
    db.close();
  }
});

test('avatar proxy falls back (404) when the rook has no avatar — no network fetch', async () => {
  const db = openTestDb();
  const did = 'did:plc:noavatar';
  seedFreshHandle(db, did, 'https://rook.host');
  db.seedProfile({ did, avatar_json: null });

  const fx = stubFetch(() => { throw new Error('must not fetch when there is no avatar'); });
  try {
    const res = await api(`/api/avatar?did=${encodeURIComponent(did)}&kind=rook`, db);
    assert.equal(res.status, 404);
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
    db.close();
  }
});

test('avatar proxy returns 502 when the upstream blob fetch fails', async () => {
  const db = openTestDb();
  const did = 'did:plc:brokenblob';
  seedFreshHandle(db, did, 'https://rook.host');
  db.seedProfile({ did, avatar_json: JSON.stringify(blobRef('bafymissing')) });

  // rookery-style 404 on getBlob (PDS error enums differ; the ok flag is authoritative).
  const fx = stubFetch(() => new Response('not found', { status: 404 }));
  try {
    const res = await api(`/api/avatar?did=${encodeURIComponent(did)}&kind=rook`, db);
    assert.equal(res.status, 502);
    assert.equal(fx.calls.length, 1);
  } finally {
    fx.restore();
    db.close();
  }
});

test('leaderboard exposes hasAvatar + content-addressed avatarCid, tolerating a malformed ref', async () => {
  const db = openTestDb();
  try {
    db.seedProfile({ did: 'did:plc:withavatar', avatar_json: JSON.stringify(blobRef('bafycid-A')), indexed_at: '2026-07-06 03:00:00' });
    db.seedProfile({ did: 'did:plc:noavatar', avatar_json: null, indexed_at: '2026-07-06 02:00:00' });
    db.seedProfile({ did: 'did:plc:badavatar', avatar_json: 'not-json', indexed_at: '2026-07-06 01:00:00' });

    const board = await leaderboard(db, 'recent', 10);
    const withA = board.find((r) => r.did === 'did:plc:withavatar');
    const none = board.find((r) => r.did === 'did:plc:noavatar');
    const bad = board.find((r) => r.did === 'did:plc:badavatar');

    assert.equal(withA.hasAvatar, true);
    assert.equal(withA.avatarCid, 'bafycid-A');
    assert.equal(none.hasAvatar, false);
    assert.equal(none.avatarCid, null);
    // A malformed blob ref must not crash the board; it degrades to the monogram.
    assert.equal(bad.hasAvatar, false);
    assert.equal(bad.avatarCid, null);
  } finally {
    db.close();
  }
});

test('indexing a profile update changes avatarCid — the client URL revalidates the cache', async () => {
  const db = openTestDb();
  const did = 'did:plc:updates';
  const uri = `at://${did}/cloud.thermals.actor.profile/self`;
  try {
    await upsertProfile(db, did, uri, 'profcid-1', {
      $type: 'cloud.thermals.actor.profile', displayName: 'r', avatar: blobRef('bafyold'), createdAt: '2026-07-06T00:00:00.000Z',
    });
    let board = await leaderboard(db, 'recent', 10);
    assert.equal(board.find((r) => r.did === did).avatarCid, 'bafyold');

    // Same DID, new avatar blob (the indexer processes a profile update).
    await upsertProfile(db, did, uri, 'profcid-2', {
      $type: 'cloud.thermals.actor.profile', displayName: 'r', avatar: blobRef('bafynew'), createdAt: '2026-07-06T01:00:00.000Z',
    });
    board = await leaderboard(db, 'recent', 10);
    assert.equal(board.find((r) => r.did === did).avatarCid, 'bafynew');
  } finally {
    db.close();
  }
});

test('byte-clean: CSP confines the browser to same-origin images on both API and asset responses', async () => {
  const db = openTestDb();
  const did = 'did:plc:cspcheck';
  seedFreshHandle(db, did, 'https://rook.host');
  db.seedProfile({ did, avatar_json: JSON.stringify(blobRef('bafycsp')) });

  const env = { ...db, ASSETS: { fetch: () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) } };
  const fx = stubFetch(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/png' } }));
  try {
    for (const path of ['/api/avatar?did=' + encodeURIComponent(did) + '&kind=rook&v=bafycsp', '/']) {
      const res = await worker.fetch(new Request(`https://thermals.cloud${path}`), env, {});
      const csp = res.headers.get('Content-Security-Policy');
      assert.ok(csp, `missing CSP on ${path}`);
      // No third-party image/connect origin is reachable from the page.
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /img-src 'self' data:/);
      assert.match(csp, /connect-src 'self'/);
      assert.doesNotMatch(csp, /https?:\/\//); // no external origin whitelisted anywhere
      // no-transform keeps Cloudflare from injecting a third-party analytics beacon.
      assert.match(res.headers.get('Cache-Control') || '', /no-transform/);
    }
  } finally {
    fx.restore();
    db.close();
  }
});

test('byte-clean: the frontend only ever builds the same-origin avatar URL', () => {
  const appjs = readFileSync(resolve(ROOT, 'public/app.js'), 'utf8');
  // The avatar image src is the same-origin proxy, never a PDS/CDN origin.
  assert.match(appjs, /<img class="avatar" src="\/api\/avatar\?did='/);
  // The frontend never speaks getBlob or any absolute image origin directly.
  assert.doesNotMatch(appjs, /getBlob/);
  assert.doesNotMatch(appjs, /src="https?:/);
});
