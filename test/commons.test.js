// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

import assert from 'node:assert/strict';
import test from 'node:test';

import { CAP_COLLECTION, PROFILE_COLLECTION, VOUCH_COLLECTION } from '../src/atproto.js';
import { pollCommons } from '../src/commons.js';
import { openTestDb } from './helpers/d1.js';

function trackingEnv(db) {
  const queries = [];
  const writes = [];

  function track(statement, sql) {
    return {
      bind(...args) {
        return track(statement.bind(...args), sql);
      },
      all() {
        return statement.all();
      },
      first() {
        return statement.first();
      },
      run() {
        writes.push(sql);
        return statement.run();
      },
    };
  }

  return {
    env: {
      COMMONS_HOST: 'rook.host',
      DB: {
        prepare(sql) {
          queries.push(sql);
          return track(db.DB.prepare(sql), sql);
        },
      },
    },
    queries,
    writes,
  };
}

function seedFreshHandle(db, did) {
  db.DB.prepare(
    `INSERT INTO handles (did, handle, pds, fetched_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).bind(did, `${did.slice(-5)}.rook.host`, 'https://rook.host').run();
}

function record(did, collection, rkey, cid, value) {
  return { uri: `at://${did}/${collection}/${rkey}`, cid, value };
}

function stubCommonsFetch(repos, recordsByDidAndCollection) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/com.atproto.sync.listRepos')) {
      return Response.json({ repos });
    }
    if (url.pathname.endsWith('/com.atproto.repo.listRecords')) {
      const did = url.searchParams.get('repo');
      const collection = url.searchParams.get('collection');
      return Response.json({ records: recordsByDidAndCollection.get(`${did}\u0000${collection}`) ?? [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('commons poll skips unchanged CIDs and reconciles deletes from its collection inventory', async () => {
  const db = openTestDb();
  const liveDid = 'did:plc:live';
  const staleDid = 'did:plc:stale';
  seedFreshHandle(db, liveDid);
  seedFreshHandle(db, staleDid);

  db.seedCap({ did: liveDid, rkey: 'cap', cid: 'cap-cid' });
  db.seedVouch({ did: liveDid, rkey: 'vouch', cid: 'vouch-cid' });
  db.seedProfile({ did: liveDid, rkey: 'self', cid: 'profile-cid' });
  db.seedCap({ did: staleDid, rkey: 'gone', cid: 'gone-cid' });

  const records = new Map([
    [`${liveDid}\u0000${CAP_COLLECTION}`, [record(liveDid, CAP_COLLECTION, 'cap', 'cap-cid', {
      title: 'cap title', description: '', ref: 'cap-ref', createdAt: '2026-07-06T00:00:00.000Z',
    })]],
    [`${liveDid}\u0000${VOUCH_COLLECTION}`, [record(liveDid, VOUCH_COLLECTION, 'vouch', 'vouch-cid', {
      subject: { uri: 'at://did:plc:alice/org.v-it.cap/cap' }, ref: 'vouch-ref', kind: 'endorse', createdAt: '2026-07-06T00:00:00.000Z',
    })]],
    [`${liveDid}\u0000${PROFILE_COLLECTION}`, [record(liveDid, PROFILE_COLLECTION, 'self', 'profile-cid', {
      displayName: 'alice rook', description: 'test profile', operator: 'sol pbc', links: [], tags: ['test'], createdAt: '2026-07-06T00:00:00.000Z',
    })]],
  ]);
  const { env, queries, writes } = trackingEnv(db);
  const restoreFetch = stubCommonsFetch(
    [{ did: liveDid }, { did: staleDid }],
    records,
  );

  try {
    assert.deepEqual(await pollCommons(env), { repos: 2, records: 3 });
    assert.equal(writes.length, 1, 'only the stale row is deleted; unchanged CIDs are not re-upserted');
    assert.match(writes[0], /DELETE FROM caps/);
    assert.equal(db.DB.prepare('SELECT 1 FROM caps WHERE did = ? AND rkey = ?').bind(staleDid, 'gone').first(), null);
    const inventoryReads = queries.filter((sql) => sql.startsWith('SELECT did, rkey, cid FROM'));
    assert.equal(inventoryReads.length, 3, 'inventory reads scale by collection, not active DID');
  } finally {
    restoreFetch();
    db.close();
  }
});

test('commons poll upserts a record whose CID changed', async () => {
  const db = openTestDb();
  const did = 'did:plc:changed';
  seedFreshHandle(db, did);
  db.seedCap({ did, rkey: 'cap', cid: 'old-cid', title: 'old title' });

  const records = new Map([[
    `${did}\u0000${CAP_COLLECTION}`,
    [record(did, CAP_COLLECTION, 'cap', 'new-cid', {
      title: 'new title', description: '', ref: 'cap-ref', createdAt: '2026-07-06T00:00:00.000Z',
    })],
  ]]);
  const { env, writes } = trackingEnv(db);
  const restoreFetch = stubCommonsFetch([{ did }], records);

  try {
    await pollCommons(env);
    assert.equal(writes.length, 1);
    const stored = db.DB.prepare('SELECT cid, title FROM caps WHERE did = ? AND rkey = ?').bind(did, 'cap').first();
    assert.equal(stored.cid, 'new-cid');
    assert.equal(stored.title, 'new title');
  } finally {
    restoreFetch();
    db.close();
  }
});

test('commons poll batches its inventory reads before a large commons can exhaust bind parameters', async () => {
  const db = openTestDb();
  const dids = Array.from({ length: 101 }, (_, index) => `did:plc:batch${index}`);
  for (const did of dids) seedFreshHandle(db, did);

  const { env, queries, writes } = trackingEnv(db);
  const restoreFetch = stubCommonsFetch(dids.map((did) => ({ did })), new Map());

  try {
    assert.deepEqual(await pollCommons(env), { repos: 101, records: 0 });
    assert.equal(writes.length, 0);
    const inventoryReads = queries.filter((sql) => sql.startsWith('SELECT did, rkey, cid FROM'));
    assert.equal(inventoryReads.length, 6, 'three collections × two DID batches');
  } finally {
    restoreFetch();
    db.close();
  }
});
