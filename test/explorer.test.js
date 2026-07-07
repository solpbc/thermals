// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { handleApi } from '../src/api.js';
import { CAP_COLLECTION, PROFILE_COLLECTION, VOUCH_COLLECTION } from '../src/atproto.js';
import { axisCounts, leaderboard, rookByDid } from '../src/reputation.js';
import { openTestDb } from './helpers/d1.js';

async function api(path, env) {
  const res = await handleApi(new Request(`https://thermals.cloud${path}`), env);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

test('explorer summary counts indexed populations', async () => {
  const db = openTestDb();
  try {
    db.seedCap({ did: 'did:plc:alice', rkey: 'ship', kind: 'feat', indexed_at: '2026-07-06 10:00:00' });
    db.seedCap({ did: 'did:plc:bob', rkey: 'req', kind: 'request', indexed_at: '2026-07-06 11:00:00' });
    db.seedVouch({ did: 'did:plc:reviewer', rkey: 'v1', cap_uri: 'at://did:plc:alice/org.v-it.cap/ship', indexed_at: '2026-07-06 12:00:00' });
    db.seedProfile({ did: 'did:plc:alice', indexed_at: '2026-07-06 13:00:00' });

    const { res, body } = await api('/api/explorer/summary', db);
    assert.equal(res.status, 200);
    assert.equal(body.capsShipped.count, 1);
    assert.equal(body.requests.count, 1);
    assert.equal(body.vouches.count, 1);
    assert.equal(body.profiles.count, 1);
    assert.equal(body.profiles.latestIndexedAt, '2026-07-06 13:00:00');
  } finally {
    db.close();
  }
});

test('explorer record lookup covers caps, vouches, profiles, and errors', async () => {
  const db = openTestDb();
  try {
    db.seedHandle({ did: 'did:plc:alice', handle: 'alice.test' });
    const cap = db.seedCap({ did: 'did:plc:alice', rkey: 'cap1', title: 'trace cap', kind: 'feat' });
    const vouch = db.seedVouch({ did: 'did:plc:reviewer', rkey: 'vouch1', cap_uri: cap.uri, kind: 'endorse' });
    const profile = db.seedProfile({ did: 'did:plc:alice', display_name: 'alice' });

    let out = await api(`/api/explorer/record?uri=${encodeURIComponent(cap.uri)}`, db);
    assert.equal(out.res.status, 200);
    assert.equal(out.body.collection, CAP_COLLECTION);
    assert.equal(out.body.record.value.$type, CAP_COLLECTION);
    assert.equal(out.body.context.vouches.length, 1);

    out = await api(`/api/explorer/record?uri=${encodeURIComponent(vouch.uri)}`, db);
    assert.equal(out.res.status, 200);
    assert.equal(out.body.collection, VOUCH_COLLECTION);
    assert.equal(out.body.record.value.$type, VOUCH_COLLECTION);
    assert.equal(out.body.context.subject.title, 'trace cap');

    out = await api(`/api/explorer/record?uri=${encodeURIComponent(profile.uri)}`, db);
    assert.equal(out.res.status, 200);
    assert.equal(out.body.collection, PROFILE_COLLECTION);
    assert.equal(out.body.record.value.$type, PROFILE_COLLECTION);
    assert.equal(out.body.context.handle, 'alice.test');

    out = await api('/api/explorer/record?uri=at%3A%2F%2Fdid%3Aplc%3Ax%2Forg.v-it.cap%2Fnone', db);
    assert.equal(out.res.status, 404);
    out = await api('/api/explorer/record', db);
    assert.equal(out.res.status, 400);
  } finally {
    db.close();
  }
});

test('explorer records validates collection, filters, and paginates caps and vouches by id', async () => {
  const db = openTestDb();
  try {
    db.seedCap({ did: 'did:plc:alice', rkey: 'cap1', kind: 'feat' });
    db.seedCap({ did: 'did:plc:alice', rkey: 'cap2', kind: 'request' });
    db.seedCap({ did: 'did:plc:bob', rkey: 'cap3', kind: 'fix' });

    let out = await api('/api/explorer/records', db);
    assert.equal(out.res.status, 400);
    out = await api('/api/explorer/records?collection=bad', db);
    assert.equal(out.res.status, 400);

    out = await api(`/api/explorer/records?collection=${encodeURIComponent(CAP_COLLECTION)}&did=${encodeURIComponent('did:plc:alice')}`, db);
    assert.equal(out.res.status, 200);
    assert.equal(out.body.records.length, 2);
    assert.ok(out.body.records.every((row) => row.did === 'did:plc:alice'));

    out = await api(`/api/explorer/records?collection=${encodeURIComponent(CAP_COLLECTION)}&kind=request`, db);
    assert.equal(out.body.records.length, 1);
    assert.equal(out.body.records[0].kind, 'request');

    out = await api(`/api/explorer/records?collection=${encodeURIComponent(CAP_COLLECTION)}&limit=2`, db);
    assert.equal(out.body.records.length, 2);
    assert.ok(out.body.cursor);
    const nextCaps = await api(`/api/explorer/records?collection=${encodeURIComponent(CAP_COLLECTION)}&limit=2&cursor=${encodeURIComponent(out.body.cursor)}`, db);
    assert.equal(nextCaps.body.records.length, 1);
    assert.equal(nextCaps.body.cursor, null);

    const cap = db.seedCap({ did: 'did:plc:alice', rkey: 'cap4', kind: 'feat' });
    db.seedVouch({ did: 'did:plc:reviewer1', rkey: 'v1', cap_uri: cap.uri, kind: 'endorse' });
    db.seedVouch({ did: 'did:plc:reviewer2', rkey: 'v2', cap_uri: cap.uri, kind: 'want' });
    db.seedVouch({ did: 'did:plc:reviewer3', rkey: 'v3', cap_uri: cap.uri, kind: 'endorse' });

    out = await api(`/api/explorer/records?collection=${encodeURIComponent(VOUCH_COLLECTION)}&limit=2`, db);
    assert.equal(out.body.records.length, 2);
    assert.ok(out.body.cursor);
    const nextVouches = await api(`/api/explorer/records?collection=${encodeURIComponent(VOUCH_COLLECTION)}&limit=2&cursor=${encodeURIComponent(out.body.cursor)}`, db);
    assert.equal(nextVouches.body.records.length, 1);
    assert.equal(nextVouches.body.cursor, null);
  } finally {
    db.close();
  }
});

test('explorer profile records use compound cursor without skipping indexed_at ties', async () => {
  const db = openTestDb();
  try {
    const t = '2026-07-06 14:00:00';
    db.seedProfile({ did: 'did:plc:a', indexed_at: t, display_name: 'a' });
    db.seedProfile({ did: 'did:plc:b', indexed_at: t, display_name: 'b' });
    db.seedProfile({ did: 'did:plc:c', indexed_at: t, display_name: 'c' });

    const first = await api(`/api/explorer/records?collection=${encodeURIComponent(PROFILE_COLLECTION)}&limit=2`, db);
    assert.equal(first.res.status, 200);
    assert.deepEqual(first.body.records.map((row) => row.did), ['did:plc:c', 'did:plc:b']);
    assert.ok(first.body.cursor);

    const second = await api(`/api/explorer/records?collection=${encodeURIComponent(PROFILE_COLLECTION)}&limit=2&cursor=${encodeURIComponent(first.body.cursor)}`, db);
    assert.equal(second.res.status, 200);
    assert.deepEqual(second.body.records.map((row) => row.did), ['did:plc:a']);
    assert.equal(second.body.cursor, null);
  } finally {
    db.close();
  }
});

test('explorer actor counts agree with axis helper, list lengths, rook profile, and leaderboard', async () => {
  const db = openTestDb();
  try {
    const actor = 'did:plc:actor';
    const profileless = 'did:plc:profileless';
    db.seedHandle({ did: actor, handle: 'actor.test' });
    db.seedHandle({ did: profileless, handle: 'profileless.test' });
    db.seedProfile({ did: actor, display_name: 'actor' });

    const ship1 = db.seedCap({ did: actor, rkey: 'ship1', kind: 'feat', title: 'ship one' });
    const ship2 = db.seedCap({ did: actor, rkey: 'ship2', kind: null, title: 'ship two' });
    const req = db.seedCap({ did: actor, rkey: 'request1', kind: 'request', title: 'request one' });
    const otherCap = db.seedCap({ did: 'did:plc:other', rkey: 'other1', kind: 'feat', title: 'other cap' });

    db.seedVouch({ did: 'did:plc:r1', rkey: 'recv1', cap_uri: ship1.uri, kind: 'endorse' });
    db.seedVouch({ did: 'did:plc:r2', rkey: 'recv2', cap_uri: ship2.uri, kind: 'endorse' });
    db.seedVouch({ did: 'did:plc:r3', rkey: 'want1', cap_uri: ship1.uri, kind: 'want' });
    db.seedVouch({ did: 'did:plc:r4', rkey: 'request-endorse', cap_uri: req.uri, kind: 'endorse' });
    db.seedVouch({ did: actor, rkey: 'given1', cap_uri: otherCap.uri, kind: 'endorse' });
    db.seedVouch({ did: actor, rkey: 'given2', cap_uri: otherCap.uri, kind: 'endorse' });
    db.seedVouch({ did: actor, rkey: 'given-want', cap_uri: otherCap.uri, kind: 'want' });
    db.seedVouch({ did: 'did:plc:noise', rkey: 'noise', cap_uri: otherCap.uri, kind: 'endorse' });

    const expected = { capsShipped: 2, endorsementsReceived: 2, vouchesGiven: 2 };
    assert.deepEqual(await axisCounts(db, actor), expected);

    const out = await api(`/api/explorer/actor?did=${encodeURIComponent(actor)}`, db);
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.body.counts, expected);
    assert.equal(out.body.records.capsShipped.length, expected.capsShipped);
    assert.equal(out.body.records.endorsementsReceived.length, expected.endorsementsReceived);
    assert.equal(out.body.records.vouchesGiven.length, expected.vouchesGiven);

    const rook = await rookByDid(db, actor);
    assert.equal(rook.coder.capsShipped, expected.capsShipped);
    assert.equal(rook.coder.endorsementsReceived, expected.endorsementsReceived);
    assert.equal(rook.reviewer.vouchesGiven, expected.vouchesGiven);
    const board = await leaderboard(db, 'recent', 10);
    const boardActor = board.find((row) => row.did === actor);
    assert.equal(boardActor.coder.capsShipped, expected.capsShipped);
    assert.equal(boardActor.coder.endorsementsReceived, expected.endorsementsReceived);
    assert.equal(boardActor.reviewer.vouchesGiven, expected.vouchesGiven);

    const profilelessCap = db.seedCap({ did: profileless, rkey: 'ship', kind: 'fix' });
    db.seedVouch({ did: 'did:plc:r5', rkey: 'profileless-recv', cap_uri: profilelessCap.uri, kind: 'endorse' });
    db.seedVouch({ did: profileless, rkey: 'profileless-given', cap_uri: otherCap.uri, kind: 'endorse' });
    const profilelessOut = await api(`/api/explorer/actor?did=${encodeURIComponent(profileless)}`, db);
    assert.equal(profilelessOut.res.status, 200);
    assert.equal(profilelessOut.body.profile, null);
    assert.deepEqual(profilelessOut.body.counts, { capsShipped: 1, endorsementsReceived: 1, vouchesGiven: 1 });

    const unknownDid = await api('/api/explorer/actor?did=did%3Aplc%3Aunknown', db);
    assert.equal(unknownDid.res.status, 404);
    const unknownHandle = await api('/api/explorer/actor?handle=unknown.test', db);
    assert.equal(unknownHandle.res.status, 404);
    const missing = await api('/api/explorer/actor', db);
    assert.equal(missing.res.status, 400);
  } finally {
    db.close();
  }
});

test('worker host mapping rewrites explorer root only', async () => {
  const seen = [];
  const env = {
    ASSETS: {
      fetch(req) {
        seen.push(new URL(req.url).pathname);
        return new Response('asset');
      },
    },
  };

  let res = await worker.fetch(new Request('https://explorer.thermals.cloud/'), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['/explorer/']);

  seen.length = 0;
  res = await worker.fetch(new Request('https://thermals.cloud/'), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['/']);

  seen.length = 0;
  res = await worker.fetch(new Request('https://www.thermals.cloud/'), env, {});
  assert.equal(res.status, 301);
  assert.deepEqual(seen, []);
});
