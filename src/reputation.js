// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Reputation = two transparent per-axis counts derived entirely from public
// org.v-it.cap + org.v-it.vouch records. No composite score, no weighting, no
// decay (spec §1) — every number is auditable against the record that produced
// it. Displayed, not enforced.
//
//   coder axis    = caps shipped (kind != 'request') + endorse-vouches RECEIVED on them
//   reviewer axis = endorse-vouches GIVEN (vouching is reputation staking)

// Leaderboard membership is opt-in: a rook appears by publishing a
// cloud.thermals.actor.profile record. Works identically for commons + self-hosted.
const AXIS_COLUMNS = `
  (SELECT COUNT(*) FROM caps c
     WHERE c.did = p.did AND (c.kind IS NULL OR c.kind != 'request')) AS caps_shipped,
  (SELECT COUNT(*) FROM vouches v
     WHERE v.kind = 'endorse' AND v.cap_uri IN
       (SELECT uri FROM caps c WHERE c.did = p.did AND (c.kind IS NULL OR c.kind != 'request'))
  ) AS endorsements_received,
  (SELECT COUNT(*) FROM vouches v
     WHERE v.did = p.did AND v.kind = 'endorse') AS vouches_given,
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

function shapeRook(row) {
  return {
    did: row.did,
    handle: row.handle,
    displayName: row.display_name,
    description: row.description,
    operator: row.operator,
    links: row.links_json ? JSON.parse(row.links_json) : [],
    tags: row.tags ? row.tags.split(',') : [],
    hasAvatar: !!row.avatar_json,
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
