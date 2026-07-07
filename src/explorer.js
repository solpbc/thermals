// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

import { CAP_COLLECTION, PROFILE_COLLECTION, VOUCH_COLLECTION } from './atproto.js';
import { json, parseCursor, parseLimit } from './http.js';
import { axisCounts, rookByDid, shippedCapPredicate } from './reputation.js';

const PROFILE_CURSOR_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} did:[^\s]+$/;

export async function handleExplorer(request, env, url) {
  const { pathname } = url;
  if (pathname === '/api/explorer/summary') return summary(env);
  if (pathname === '/api/explorer/records') return records(url.searchParams, env);
  if (pathname === '/api/explorer/record') return record(url.searchParams, env);
  if (pathname === '/api/explorer/actor') return actor(url.searchParams, env);
  return json({ error: 'not found' }, 404);
}

async function summary(env) {
  const [capsShipped, requests, vouches, profiles] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) count, MAX(indexed_at) latestIndexedAt FROM caps c WHERE ${shippedCapPredicate('c')}`),
    env.DB.prepare("SELECT COUNT(*) count, MAX(indexed_at) latestIndexedAt FROM caps WHERE kind = 'request'"),
    env.DB.prepare('SELECT COUNT(*) count, MAX(indexed_at) latestIndexedAt FROM vouches'),
    env.DB.prepare('SELECT COUNT(*) count, MAX(indexed_at) latestIndexedAt FROM profiles'),
  ]);
  return json({
    capsShipped: countShape(capsShipped.results?.[0]),
    requests: countShape(requests.results?.[0]),
    vouches: countShape(vouches.results?.[0]),
    profiles: countShape(profiles.results?.[0]),
  });
}

async function records(searchParams, env) {
  const collection = searchParams.get('collection');
  if (!isCollection(collection)) return json({ error: 'bad collection' }, 400);

  const did = searchParams.get('did');
  const kind = searchParams.get('kind');
  const limit = parseLimit(searchParams.get('limit'));
  const cursorParam = searchParams.get('cursor');

  if (collection === CAP_COLLECTION) {
    const conditions = [];
    const bindings = [];
    if (did) { conditions.push('c.did = ?'); bindings.push(did); }
    if (kind) { conditions.push('c.kind = ?'); bindings.push(kind); }
    const cursor = parseCursor(cursorParam);
    if (cursor) { conditions.push('c.id < ?'); bindings.push(cursor); }
    const { results } = await env.DB.prepare(
      `SELECT c.*, h.handle
       FROM caps c LEFT JOIN handles h ON c.did = h.did
       ${whereClause(conditions)}
       ORDER BY c.id DESC
       LIMIT ?`,
    ).bind(...bindings, limit).all();
    return json(recordsShape(results ?? [], limit, (row) => String(row.id)));
  }

  if (collection === VOUCH_COLLECTION) {
    const conditions = [];
    const bindings = [];
    if (did) { conditions.push('v.did = ?'); bindings.push(did); }
    if (kind) { conditions.push('v.kind = ?'); bindings.push(kind); }
    const cursor = parseCursor(cursorParam);
    if (cursor) { conditions.push('v.id < ?'); bindings.push(cursor); }
    const { results } = await env.DB.prepare(
      `SELECT v.*, h.handle
       FROM vouches v LEFT JOIN handles h ON v.did = h.did
       ${whereClause(conditions)}
       ORDER BY v.id DESC
       LIMIT ?`,
    ).bind(...bindings, limit).all();
    return json(recordsShape(results ?? [], limit, (row) => String(row.id)));
  }

  const conditions = [];
  const bindings = [];
  if (did) { conditions.push('p.did = ?'); bindings.push(did); }
  const cursor = decodeProfileCursor(cursorParam);
  if (cursor) {
    conditions.push('(p.indexed_at < ? OR (p.indexed_at = ? AND p.did < ?))');
    bindings.push(cursor.indexedAt, cursor.indexedAt, cursor.did);
  }
  const { results } = await env.DB.prepare(
    `SELECT p.*, h.handle
     FROM profiles p LEFT JOIN handles h ON p.did = h.did
     ${whereClause(conditions)}
     ORDER BY p.indexed_at DESC, p.did DESC
     LIMIT ?`,
  ).bind(...bindings, limit).all();
  return json(recordsShape(results ?? [], limit, (row) => encodeProfileCursor(row.indexed_at, row.did)));
}

async function record(searchParams, env) {
  const uri = searchParams.get('uri');
  if (!uri) return json({ error: 'uri required' }, 400);

  const cap = await env.DB.prepare(
    `SELECT c.*, h.handle
     FROM caps c LEFT JOIN handles h ON c.did = h.did
     WHERE c.uri = ?`,
  ).bind(uri).first();
  if (cap) {
    const { results: vouches } = await env.DB.prepare(
      `SELECT v.*, h.handle
       FROM vouches v LEFT JOIN handles h ON v.did = h.did
       WHERE v.cap_uri = ?
       ORDER BY v.id DESC`,
    ).bind(uri).all();
    return json({
      collection: CAP_COLLECTION,
      record: shapeRow(cap),
      context: { vouches: (vouches ?? []).map(shapeRow) },
    });
  }

  const vouch = await env.DB.prepare(
    `SELECT v.*, h.handle
     FROM vouches v LEFT JOIN handles h ON v.did = h.did
     WHERE v.uri = ?`,
  ).bind(uri).first();
  if (vouch) {
    const subject = await env.DB.prepare(
      `SELECT c.uri, c.did, h.handle, c.title, c.ref, c.kind, c.created_at
       FROM caps c LEFT JOIN handles h ON c.did = h.did
       WHERE c.uri = ?`,
    ).bind(vouch.cap_uri).first();
    return json({
      collection: VOUCH_COLLECTION,
      record: shapeRow(vouch),
      context: { subject: subject ?? { uri: vouch.cap_uri } },
    });
  }

  const profile = await env.DB.prepare(
    `SELECT p.*, h.handle
     FROM profiles p LEFT JOIN handles h ON p.did = h.did
     WHERE p.uri = ?`,
  ).bind(uri).first();
  if (profile) {
    return json({
      collection: PROFILE_COLLECTION,
      record: shapeRow(profile),
      context: { handle: profile.handle ?? null },
    });
  }

  return json({ error: 'not found' }, 404);
}

async function actor(searchParams, env) {
  let did = searchParams.get('did');
  const handle = searchParams.get('handle');
  let handleRow = null;

  if (!did && !handle) return json({ error: 'did or handle required' }, 400);
  if (!did && handle) {
    handleRow = await env.DB.prepare('SELECT did, handle FROM handles WHERE handle = ?').bind(handle).first();
    if (!handleRow) return json({ error: 'not found' }, 404);
    did = handleRow.did;
  } else if (did) {
    handleRow = await env.DB.prepare('SELECT did, handle FROM handles WHERE did = ?').bind(did).first();
  }

  const presence = await env.DB.prepare(
    `SELECT 1 found FROM profiles WHERE did = ?
     UNION ALL SELECT 1 FROM caps WHERE did = ?
     UNION ALL SELECT 1 FROM vouches WHERE did = ?
     LIMIT 1`,
  ).bind(did, did, did).first();
  if (!presence) return json({ error: 'not found' }, 404);

  const [profile, counts, capsShipped, endorsementsReceived, vouchesGiven] = await Promise.all([
    rookByDid(env, did),
    axisCounts(env, did),
    env.DB.prepare(
      `SELECT c.*, h.handle
       FROM caps c LEFT JOIN handles h ON c.did = h.did
       WHERE c.did = ? AND ${shippedCapPredicate('c')}
       ORDER BY c.id DESC`,
    ).bind(did).all(),
    env.DB.prepare(
      `SELECT v.*, hv.handle, c.title AS cap_title, c.ref AS cap_ref, c.kind AS cap_kind
       FROM vouches v
       JOIN caps c ON v.cap_uri = c.uri
       LEFT JOIN handles hv ON v.did = hv.did
       WHERE v.kind = 'endorse' AND c.did = ? AND ${shippedCapPredicate('c')}
       ORDER BY v.id DESC`,
    ).bind(did).all(),
    env.DB.prepare(
      `SELECT v.*, h.handle, c.title AS cap_title, c.ref AS cap_ref, c.kind AS cap_kind
       FROM vouches v
       LEFT JOIN handles h ON v.did = h.did
       LEFT JOIN caps c ON v.cap_uri = c.uri
       WHERE v.did = ? AND v.kind = 'endorse'
       ORDER BY v.id DESC`,
    ).bind(did).all(),
  ]);

  return json({
    did,
    handle: profile?.handle ?? handleRow?.handle ?? handle ?? null,
    profile,
    counts,
    records: {
      capsShipped: (capsShipped.results ?? []).map(shapeRow),
      endorsementsReceived: (endorsementsReceived.results ?? []).map(shapeRow),
      vouchesGiven: (vouchesGiven.results ?? []).map(shapeRow),
    },
  });
}

function isCollection(collection) {
  return collection === CAP_COLLECTION || collection === VOUCH_COLLECTION || collection === PROFILE_COLLECTION;
}

function countShape(row) {
  return {
    count: row?.count ?? 0,
    latestIndexedAt: row?.latestIndexedAt ?? null,
  };
}

function recordsShape(rows, limit, cursorFor) {
  const records = rows.map(shapeRow);
  return {
    records,
    cursor: rows.length < limit || rows.length === 0 ? null : cursorFor(rows[rows.length - 1]),
  };
}

function whereClause(conditions) {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

function shapeRow(row) {
  const out = { ...row, value: parseRecordJson(row.record_json) };
  return out;
}

function parseRecordJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function encodeProfileCursor(indexedAt, did) {
  if (!indexedAt || !did) return null;
  return btoa(`${indexedAt} ${did}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeProfileCursor(token) {
  if (!token) return null;
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (token.length % 4)) % 4);
    const decoded = atob(padded);
    if (!PROFILE_CURSOR_RE.test(decoded)) return null;
    return { indexedAt: decoded.slice(0, 19), did: decoded.slice(20) };
  } catch {
    return null;
  }
}
