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

const TABLE_BY_COLLECTION = {
  [CAP_COLLECTION]: 'caps',
  [VOUCH_COLLECTION]: 'vouches',
  [PROFILE_COLLECTION]: 'profiles',
};

export async function pollCommons(env) {
  const base = `https://${env.COMMONS_HOST}`;
  const repos = await listRepos(base);
  let seen = 0;
  for (const { did, active } of repos) {
    if (!active) continue;
    // Cache handle/pds for this commons DID (commons is its own PDS).
    await resolveDid(did, env);
    for (const collection of COLLECTIONS) {
      const records = await listRecords(base, did, collection);
      const liveRkeys = new Set();
      for (const r of records) {
        await upsertByCollection(env, collection, did, r.uri, r.cid, r.value);
        liveRkeys.add(r.uri.split('/').pop());
        seen++;
      }
      await reconcileDeletes(env, collection, did, liveRkeys);
    }
  }
  return { repos: repos.length, records: seen };
}

// Prune rows for this DID+collection whose rkey is absent from the live set.
async function reconcileDeletes(env, collection, did, liveRkeys) {
  const table = TABLE_BY_COLLECTION[collection];
  const { results } = await env.DB.prepare(`SELECT rkey FROM ${table} WHERE did = ?`).bind(did).all();
  for (const row of results ?? []) {
    if (!liveRkeys.has(row.rkey)) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE did = ? AND rkey = ?`).bind(did, row.rkey).run();
    }
  }
}
