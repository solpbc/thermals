// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Jetstream tail over the whole bsky network. Catches human requesters posting
// from their bsky PDS, plus any rook records that federate through the relay.
// Cron-driven (no persistent WS on Workers — see cpo/workspace/vit-indexer-feasibility.md).

import {
  CAP_COLLECTION, VOUCH_COLLECTION, PROFILE_COLLECTION, resolveDids,
} from './atproto.js';
import { upsertByCollection, deleteRecord } from './store.js';

const STREAM_DURATION_MS = 55_000;
const WANTED = [CAP_COLLECTION, VOUCH_COLLECTION, PROFILE_COLLECTION];

export async function streamEvents(env, cursor) {
  const url = new URL(env.JETSTREAM_URL);
  for (const c of WANTED) url.searchParams.append('wantedCollections', c);
  if (cursor) url.searchParams.set('cursor', cursor);

  return await new Promise((resolve) => {
    let latestCursor = cursor || null;
    // With wantedCollections filtering, matching events are rare — most windows
    // see none and latestCursor would never advance. Fall back to the window's
    // open time so the next window resumes from here (replaying this window is
    // harmless: upsert/delete by URI are idempotent).
    const openCursor = String(Date.now() * 1000);
    const newDids = new Set();
    const pending = new Set();
    const ws = new WebSocket(url.toString());

    const timeout = setTimeout(() => ws.close(), STREAM_DURATION_MS);

    const finish = async () => {
      clearTimeout(timeout);
      if (pending.size > 0) await Promise.allSettled([...pending]);
      if (newDids.size > 0) await resolveDids([...newDids], env);
      const next = latestCursor && latestCursor !== cursor ? latestCursor : openCursor;
      resolve({ latestCursor: next });
    };

    ws.addEventListener('message', (event) => {
      const task = (async () => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.kind !== 'commit') return;
        if (msg.time_us) latestCursor = String(msg.time_us);

        const commit = msg.commit;
        if (!commit || !WANTED.includes(commit.collection)) return;

        const did = msg.did;
        newDids.add(did);
        const uri = `at://${did}/${commit.collection}/${commit.rkey}`;

        if (commit.operation === 'create' || commit.operation === 'update') {
          if (commit.record) {
            await upsertByCollection(env, commit.collection, did, uri, commit.cid, commit.record);
          }
        } else if (commit.operation === 'delete') {
          await deleteRecord(env, commit.collection, did, commit.rkey);
        }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    });

    ws.addEventListener('close', () => void finish());
    ws.addEventListener('error', () => ws.close());
  });
}
