// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Direct commons poll — the relay-independent coverage path. The rook.host
// commons is a federating PDS, but whether bsky.network crawls it (so its
// records reach jetstream2) is unproven. Rather than bet the launch on the
// relay, we enumerate the commons directly: listRepos → listRecords for the
// three collections → upsert. Idempotent with the Jetstream path (UNIQUE(uri)).
//
// Reconciliation gives us delete propagation for the commons: any DID+collection
// row in D1 that is NOT in the current listRecords set is pruned — "indexes,
// never owns" holds even if we miss a delete event.

import {
  CAP_COLLECTION, VOUCH_COLLECTION, PROFILE_COLLECTION,
  listRepos, listRecords, resolveDid,
} from './atproto.js';
import { upsertByCollection } from './store.js';

const COLLECTIONS = [CAP_COLLECTION, VOUCH_COLLECTION, PROFILE_COLLECTION];
const DID_BATCH_SIZE = 100;

const TABLE_BY_COLLECTION = {
  [CAP_COLLECTION]: 'caps',
  [VOUCH_COLLECTION]: 'vouches',
  [PROFILE_COLLECTION]: 'profiles',
};

export async function pollCommons(env) {
  const base = `https://${env.COMMONS_HOST}`;
  const repos = await listRepos(base);
  const activeDids = repos.filter(({ active }) => active).map(({ did }) => did);

  // The handle/PDS cache is separate from the record inventory below. Resolve
  // each active DID once, then read each collection's current D1 rows once so
  // the poll can cheaply distinguish unchanged records from updates and reuse
  // the same inventory to reconcile deletes.
  for (const did of activeDids) {
    await resolveDid(did, env);
  }

  let seen = 0;
  for (const collection of COLLECTIONS) {
    const indexed = await indexedRecords(env, collection, activeDids);
    for (const did of activeDids) {
      const records = await listRecords(base, did, collection);
      for (const r of records) {
        const rkey = r.uri.split('/').pop();
        const key = recordKey(did, rkey);
        const prior = indexed.get(key);
        // A record CID is immutable. Without one, keep the conservative
        // behavior and refresh the row rather than treating unknown as equal.
        if (!r.cid || prior?.cid !== r.cid) {
          await upsertByCollection(env, collection, did, r.uri, r.cid, r.value);
        }
        indexed.delete(key);
        seen++;
      }
    }
    await reconcileDeletes(env, collection, indexed);
  }
  return { repos: repos.length, records: seen };
}

function recordKey(did, rkey) {
  return `${did}\u0000${rkey}`;
}

// Load the indexed rows for all active commons DIDs in one query per
// collection. The returned map is reduced as the PDS records are observed;
// leftovers are records whose source row has disappeared.
async function indexedRecords(env, collection, dids) {
  if (dids.length === 0) return new Map();
  const table = TABLE_BY_COLLECTION[collection];
  const indexed = new Map();
  // The commons can grow beyond a database's bind-parameter limit. Batching
  // keeps the one-query-per-collection shape for normal sizes without turning
  // a larger commons into a failed poll.
  for (let offset = 0; offset < dids.length; offset += DID_BATCH_SIZE) {
    const batch = dids.slice(offset, offset + DID_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT did, rkey, cid FROM ${table} WHERE did IN (${placeholders})`,
    ).bind(...batch).all();
    for (const row of results ?? []) {
      indexed.set(recordKey(row.did, row.rkey), row);
    }
  }
  return indexed;
}

// Prune the active commons rows left after the PDS enumeration. This preserves
// the next-cycle delete guarantee without a separate D1 read per DID.
async function reconcileDeletes(env, collection, indexed) {
  const table = TABLE_BY_COLLECTION[collection];
  for (const { did, rkey } of indexed.values()) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE did = ? AND rkey = ?`).bind(did, rkey).run();
  }
}
