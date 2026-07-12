// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

import { blobCid } from './atproto.js';

// Reputation = two transparent per-axis counts derived entirely from public
// org.v-it.cap + org.v-it.vouch records. No composite score, no weighting, no
// decay (spec §1) — every number is auditable against the record that produced
// it. Displayed, not enforced.
//
//   coder axis    = caps shipped (kind != 'request') + endorse-vouches RECEIVED on them
//   reviewer axis = endorse-vouches GIVEN (vouching is reputation staking)

export function shippedCapPredicate(alias) {
  return `(${alias}.kind IS NULL OR ${alias}.kind != 'request')`;
}

function axisCountColumns(didExpr) {
  const shipped = shippedCapPredicate('c');
  return `
  (SELECT COUNT(*) FROM caps c
     WHERE c.did = ${didExpr} AND ${shipped}) AS caps_shipped,
  (SELECT COUNT(*) FROM vouches v
     WHERE v.kind = 'endorse' AND v.cap_uri IN
       (SELECT uri FROM caps c WHERE c.did = ${didExpr} AND ${shipped})
  ) AS endorsements_received,
  (SELECT COUNT(*) FROM vouches v
     WHERE v.did = ${didExpr} AND v.kind = 'endorse') AS vouches_given`;
}

// Leaderboard membership is opt-in: a rook appears by publishing a
// cloud.thermals.actor.profile record. Works identically for commons + self-hosted.
const AXIS_COLUMNS = `${axisCountColumns('p.did')},
  (SELECT MAX(ts) FROM (
     SELECT created_at AS ts FROM caps WHERE did = p.did
     UNION ALL SELECT created_at FROM vouches WHERE did = p.did
     UNION ALL SELECT p.created_at
  )) AS last_activity`;

const ORDER = {
  recent: 'last_activity DESC',
  coder: 'caps_shipped DESC, endorsements_received DESC, last_activity DESC',
  reviewer: 'vouches_given DESC, last_activity DESC',
};

export async function leaderboard(env, sort, limit) {
  const order = ORDER[sort] ?? ORDER.recent;
  const sql = `
    SELECT p.did, p.display_name, p.description, p.operator, p.links_json, p.tags,
           p.avatar_json, p.created_at, h.handle, ${AXIS_COLUMNS}
    FROM profiles p LEFT JOIN handles h ON p.did = h.did
    ORDER BY ${order} LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(limit).all();
  return (results ?? []).map(shapeRook);
}

export async function rookByDid(env, did) {
  const sql = `
    SELECT p.did, p.display_name, p.description, p.operator, p.links_json, p.tags,
           p.avatar_json, p.created_at, h.handle, ${AXIS_COLUMNS}
    FROM profiles p LEFT JOIN handles h ON p.did = h.did
    WHERE p.did = ?`;
  const row = await env.DB.prepare(sql).bind(did).first();
  return row ? shapeRook(row) : null;
}

export async function axisCounts(env, did) {
  const row = await env.DB.prepare(`SELECT ${axisCountColumns('?')}`).bind(did, did, did).first();
  return {
    capsShipped: row?.caps_shipped ?? 0,
    endorsementsReceived: row?.endorsements_received ?? 0,
    vouchesGiven: row?.vouches_given ?? 0,
  };
}

// Parse the stored blob-ref JSON, tolerating a malformed value (never crash the
// board over one bad row). Returns the ref object or null.
function parseAvatar(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function shapeRook(row) {
  const avatar = parseAvatar(row.avatar_json);
  return {
    did: row.did,
    handle: row.handle,
    displayName: row.display_name,
    description: row.description,
    operator: row.operator,
    links: row.links_json ? JSON.parse(row.links_json) : [],
    tags: row.tags ? row.tags.split(',') : [],
    hasAvatar: !!avatar,
    // Content CID of the avatar blob — a cache version the client appends to the
    // proxy URL so a profile update (new blob CID) revalidates the cached image.
    avatarCid: avatar ? blobCid(avatar) : null,
    createdAt: row.created_at,
    coder: {
      capsShipped: row.caps_shipped ?? 0,
      endorsementsReceived: row.endorsements_received ?? 0,
    },
    reviewer: {
      vouchesGiven: row.vouches_given ?? 0,
    },
    lastActivity: row.last_activity,
  };
}
