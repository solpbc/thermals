// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Record → D1 upsert/delete. Shared by both index paths (Jetstream events and
// the direct commons poll) so a record arriving via either is idempotent
// (UNIQUE(uri)). Indexes, never owns: a delete here mirrors a delete at the PDS.

import { CAP_COLLECTION, VOUCH_COLLECTION, PROFILE_COLLECTION } from './atproto.js';

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Pull a fork+branch (or any repo) link off an implementation cap. Spec locks
// this as embed.external.uri (or a facet link); embed.external is the norm.
function forkUrl(record) {
  const embed = record?.embed;
  if (embed?.$type === 'app.bsky.embed.external' && str(embed.external?.uri)) {
    return embed.external.uri;
  }
  if (embed?.$type === 'app.bsky.embed.recordWithMedia' && embed.media?.$type === 'app.bsky.embed.external') {
    return str(embed.media.external?.uri);
  }
  // Fallback: first URI facet.
  for (const facet of record?.facets ?? []) {
    for (const feat of facet?.features ?? []) {
      if (feat?.$type === 'app.bsky.richtext.facet#link' && str(feat.uri)) return feat.uri;
    }
  }
  return null;
}

export async function upsertCap(env, did, uri, cid, record) {
  const rkey = uri.split('/').pop();
  await env.DB.prepare(
    `INSERT INTO caps (did, rkey, uri, cid, title, description, ref, beacon, kind,
       reply_root_uri, reply_parent_uri, fork_url, record_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(did, rkey) DO UPDATE SET
       cid = excluded.cid, title = excluded.title, description = excluded.description,
       ref = excluded.ref, beacon = excluded.beacon, kind = excluded.kind,
       reply_root_uri = excluded.reply_root_uri, reply_parent_uri = excluded.reply_parent_uri,
       fork_url = excluded.fork_url, record_json = excluded.record_json, created_at = excluded.created_at`,
  ).bind(
    did, rkey, uri, cid ?? null,
    record.title ?? '', record.description ?? '', record.ref ?? '',
    str(record.beacon), str(record.kind),
    str(record.reply?.root?.uri), str(record.reply?.parent?.uri), forkUrl(record),
    JSON.stringify(record), record.createdAt ?? new Date(0).toISOString(),
  ).run();
}

export async function upsertVouch(env, did, uri, cid, record) {
  const rkey = uri.split('/').pop();
  const kind = str(record.kind) ?? 'endorse';
  await env.DB.prepare(
    `INSERT INTO vouches (did, rkey, uri, cid, cap_uri, ref, beacon, kind, record_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(did, rkey) DO UPDATE SET
       cid = excluded.cid, cap_uri = excluded.cap_uri, ref = excluded.ref,
       beacon = excluded.beacon, kind = excluded.kind,
       record_json = excluded.record_json, created_at = excluded.created_at`,
  ).bind(
    did, rkey, uri, cid ?? null,
    record.subject?.uri ?? '', str(record.ref), str(record.beacon), kind,
    JSON.stringify(record), record.createdAt ?? new Date(0).toISOString(),
  ).run();
}

export async function upsertProfile(env, did, uri, cid, record) {
  const rkey = uri.split('/').pop();
  await env.DB.prepare(
    `INSERT INTO profiles (did, rkey, uri, cid, display_name, description, avatar_json,
       operator, links_json, tags, record_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(did) DO UPDATE SET
       rkey = excluded.rkey, uri = excluded.uri, cid = excluded.cid,
       display_name = excluded.display_name, description = excluded.description,
       avatar_json = excluded.avatar_json, operator = excluded.operator,
       links_json = excluded.links_json, tags = excluded.tags,
       record_json = excluded.record_json, created_at = excluded.created_at`,
  ).bind(
    did, rkey, uri, cid ?? null,
    str(record.displayName), str(record.description),
    record.avatar ? JSON.stringify(record.avatar) : null,
    str(record.operator),
    Array.isArray(record.links) ? JSON.stringify(record.links) : null,
    Array.isArray(record.tags) ? record.tags.join(',') : null,
    JSON.stringify(record), record.createdAt ?? new Date(0).toISOString(),
  ).run();
}

export async function deleteRecord(env, collection, did, rkey) {
  if (collection === CAP_COLLECTION) {
    await env.DB.prepare('DELETE FROM caps WHERE did = ? AND rkey = ?').bind(did, rkey).run();
  } else if (collection === VOUCH_COLLECTION) {
    await env.DB.prepare('DELETE FROM vouches WHERE did = ? AND rkey = ?').bind(did, rkey).run();
  } else if (collection === PROFILE_COLLECTION) {
    await env.DB.prepare('DELETE FROM profiles WHERE did = ? AND rkey = ?').bind(did, rkey).run();
  }
}

// Route a create/update record to the right table by collection.
export async function upsertByCollection(env, collection, did, uri, cid, record) {
  if (collection === CAP_COLLECTION) return upsertCap(env, did, uri, cid, record);
  if (collection === VOUCH_COLLECTION) return upsertVouch(env, did, uri, cid, record);
  if (collection === PROFILE_COLLECTION) return upsertProfile(env, did, uri, cid, record);
}
