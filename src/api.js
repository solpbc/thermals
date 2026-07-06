// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Read APIs the VPX experience layer (2.c) renders against. Every surface is
// usable signed-out. Includes an avatar proxy so the browser makes zero
// third-party requests (byte-clean AC): images are fetched server-side and
// streamed from the thermals.cloud origin.

import { leaderboard, rookByDid } from './reputation.js';
import { resolveDid, blobUrl, PROFILE_COLLECTION } from './atproto.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function parseLimit(v, def = 50, max = 100) {
  const n = Number.parseInt(v ?? String(def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function parseCursor(v) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;

  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  if (pathname === '/api/health') {
    return json({ status: 'ok', service: 'thermals-appview' });
  }

  // ---- leaderboard (read surface 1) ----
  if (pathname === '/api/leaderboard') {
    const sort = searchParams.get('sort') || 'recent';
    const limit = parseLimit(searchParams.get('limit'));
    return json({ rooks: await leaderboard(env, sort, limit), sort });
  }

  // ---- single rook profile page ----
  if (pathname === '/api/rook') {
    let did = searchParams.get('did');
    const handle = searchParams.get('handle');
    if (!did && handle) {
      const row = await env.DB.prepare('SELECT did FROM handles WHERE handle = ?').bind(handle).first();
      did = row?.did ?? null;
    }
    if (!did) return json({ error: 'did or handle required' }, 400);

    const rook = await rookByDid(env, did);
    if (!rook) return json({ error: 'not found' }, 404);

    // Their caps, endorse-vouches given, and requests they fulfilled.
    const { results: caps } = await env.DB.prepare(
      `SELECT uri, title, ref, beacon, kind, fork_url, reply_parent_uri, created_at
       FROM caps WHERE did = ? ORDER BY created_at DESC LIMIT 200`,
    ).bind(did).all();
    const { results: given } = await env.DB.prepare(
      `SELECT v.cap_uri, v.kind, v.created_at, c.title, c.ref
       FROM vouches v LEFT JOIN caps c ON v.cap_uri = c.uri
       WHERE v.did = ? AND v.kind = 'endorse' ORDER BY v.created_at DESC LIMIT 200`,
    ).bind(did).all();
    return json({ rook, caps, vouchesGiven: given });
  }

  // ---- open request list (read surface 2) ----
  if (pathname === '/api/requests') {
    const sort = searchParams.get('sort') || 'recent';
    const limit = parseLimit(searchParams.get('limit'));
    const cursor = parseCursor(searchParams.get('cursor'));

    const conditions = ["c.kind = 'request'"];
    const bindings = [];
    if (cursor) { conditions.push('c.id < ?'); bindings.push(cursor); }

    let sql = `
      SELECT c.id, c.uri, c.did, c.title, c.description, c.ref, c.beacon, c.created_at,
             h.handle,
             (SELECT COUNT(*) FROM vouches v WHERE v.cap_uri = c.uri AND v.kind = 'want') AS want_vouches,
             (SELECT COUNT(*) FROM caps i WHERE i.reply_parent_uri = c.uri AND i.kind != 'request') AS implementations
      FROM caps c LEFT JOIN handles h ON c.did = h.did
      WHERE ${conditions.join(' AND ')}`;
    sql += sort === 'want-vouches'
      ? ' ORDER BY want_vouches DESC, c.id DESC'
      : ' ORDER BY c.id DESC';
    sql += ' LIMIT ?';
    bindings.push(limit);

    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    return json({
      requests: results ?? [],
      cursor: results?.length ? results[results.length - 1].id : null,
      sort,
    });
  }

  // ---- single request + fulfillment lineage ----
  if (pathname === '/api/request') {
    const uri = searchParams.get('uri');
    if (!uri) return json({ error: 'uri required' }, 400);

    const req = await env.DB.prepare(
      `SELECT c.*, h.handle,
         (SELECT COUNT(*) FROM vouches v WHERE v.cap_uri = c.uri AND v.kind = 'want') AS want_vouches
       FROM caps c LEFT JOIN handles h ON c.did = h.did
       WHERE c.uri = ? AND c.kind = 'request'`,
    ).bind(uri).first();
    if (!req) return json({ error: 'not found' }, 404);

    // Implementation caps: caps that reply to this request, carrying fork+branch.
    const { results: impls } = await env.DB.prepare(
      `SELECT c.uri, c.did, c.title, c.ref, c.kind, c.fork_url, c.created_at, h.handle
       FROM caps c LEFT JOIN handles h ON c.did = h.did
       WHERE c.reply_parent_uri = ? AND c.kind != 'request'
       ORDER BY c.created_at DESC`,
    ).bind(uri).all();
    return json({ request: req, implementations: impls ?? [] });
  }

  // ---- avatar proxy (byte-clean: images stream from thermals origin) ----
  if (pathname === '/api/avatar') {
    return avatarProxy(searchParams, env);
  }

  // ---- stats ----
  if (pathname === '/api/stats') {
    const [rooks, caps, requests, vouches] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) c FROM profiles'),
      env.DB.prepare("SELECT COUNT(*) c FROM caps WHERE kind IS NULL OR kind != 'request'"),
      env.DB.prepare("SELECT COUNT(*) c FROM caps WHERE kind = 'request'"),
      env.DB.prepare('SELECT COUNT(*) c FROM vouches'),
    ]);
    return json({
      rooks: rooks.results[0]?.c ?? 0,
      caps_shipped: caps.results[0]?.c ?? 0,
      open_requests: requests.results[0]?.c ?? 0,
      vouches: vouches.results[0]?.c ?? 0,
    });
  }

  return json({ error: 'not found' }, 404);
}

// Resolve a DID's avatar blob and stream it from our origin. Supports the rook
// thermals profile avatar (kind=rook) and a bsky profile avatar (default).
async function avatarProxy(searchParams, env) {
  const did = searchParams.get('did');
  if (!did) return new Response('did required', { status: 400 });
  const kind = searchParams.get('kind') || 'bsky';

  const resolved = await resolveDid(did, env);
  if (!resolved?.pds) return new Response('no pds', { status: 404 });

  let blobRef = null;
  if (kind === 'rook') {
    const row = await env.DB.prepare('SELECT avatar_json FROM profiles WHERE did = ?').bind(did).first();
    blobRef = row?.avatar_json ? JSON.parse(row.avatar_json) : null;
  } else {
    // bsky profile record: app.bsky.actor.profile / self.
    const u = new URL(`${resolved.pds}/xrpc/com.atproto.repo.getRecord`);
    u.searchParams.set('repo', did);
    u.searchParams.set('collection', 'app.bsky.actor.profile');
    u.searchParams.set('rkey', 'self');
    const res = await fetch(u.toString());
    if (res.ok) blobRef = (await res.json())?.value?.avatar ?? null;
  }
  if (!blobRef) return new Response('no avatar', { status: 404 });

  const src = blobUrl(resolved.pds, did, blobRef);
  if (!src) return new Response('no avatar', { status: 404 });
  const img = await fetch(src);
  if (!img.ok) return new Response('fetch failed', { status: 502 });
  return new Response(img.body, {
    status: 200,
    headers: {
      'Content-Type': img.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
