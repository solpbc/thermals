// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAP_COLLECTION, PROFILE_COLLECTION, VOUCH_COLLECTION } from '../../src/atproto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let nextRkey = 1;

export function openTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(resolve(ROOT, 'schema.sql'), 'utf8'));

  const DB = {
    prepare(sql) {
      return wrapStatement(sqlite.prepare(sql));
    },
    batch(stmts) {
      return stmts.map((stmt) => ({ results: stmt._allRows() }));
    },
  };

  return {
    DB,
    close: () => sqlite.close(),
    seedCap: (row = {}) => seedCap(DB, row),
    seedVouch: (row = {}) => seedVouch(DB, row),
    seedProfile: (row = {}) => seedProfile(DB, row),
    seedHandle: (row = {}) => seedHandle(DB, row),
  };
}

function wrapStatement(stmt, args = []) {
  return {
    bind(...nextArgs) {
      return wrapStatement(stmt, nextArgs);
    },
    all() {
      return { results: stmt.all(...args) };
    },
    first() {
      return stmt.get(...args) ?? null;
    },
    run() {
      return stmt.run(...args);
    },
    _allRows() {
      return stmt.all(...args);
    },
  };
}

function seedCap(DB, row) {
  const did = row.did ?? 'did:plc:alice';
  const rkey = row.rkey ?? randomRkey();
  const uri = row.uri ?? `at://${did}/${CAP_COLLECTION}/${rkey}`;
  const record = row.record ?? {
    $type: CAP_COLLECTION,
    title: row.title ?? 'cap title',
    description: row.description ?? '',
    ref: row.ref ?? 'cap-ref',
    beacon: row.beacon ?? 'https://github.com/sol/test',
    kind: row.kind,
    createdAt: row.created_at ?? '2026-07-06T00:00:00.000Z',
  };
  DB.prepare(
    `INSERT INTO caps (did, rkey, uri, cid, title, description, ref, beacon, kind,
       reply_root_uri, reply_parent_uri, fork_url, record_json, created_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    did,
    rkey,
    uri,
    row.cid ?? `cid-${rkey}`,
    row.title ?? record.title ?? 'cap title',
    row.description ?? record.description ?? '',
    row.ref ?? record.ref ?? 'cap-ref',
    row.beacon ?? record.beacon ?? null,
    row.kind ?? record.kind ?? null,
    row.reply_root_uri ?? null,
    row.reply_parent_uri ?? null,
    row.fork_url ?? null,
    JSON.stringify(record),
    row.created_at ?? record.createdAt ?? '2026-07-06T00:00:00.000Z',
    row.indexed_at ?? '2026-07-06 00:00:00',
  ).run();
  return DB.prepare('SELECT * FROM caps WHERE uri = ?').bind(uri).first();
}

function seedVouch(DB, row) {
  const did = row.did ?? 'did:plc:reviewer';
  const rkey = row.rkey ?? randomRkey();
  const uri = row.uri ?? `at://${did}/${VOUCH_COLLECTION}/${rkey}`;
  const record = row.record ?? {
    $type: VOUCH_COLLECTION,
    subject: { uri: row.cap_uri ?? 'at://did:plc:alice/org.v-it.cap/cap' },
    ref: row.ref ?? 'vouch-ref',
    beacon: row.beacon ?? 'https://github.com/sol/test',
    kind: row.kind ?? 'endorse',
    createdAt: row.created_at ?? '2026-07-06T00:00:00.000Z',
  };
  DB.prepare(
    `INSERT INTO vouches (did, rkey, uri, cid, cap_uri, ref, beacon, kind, record_json, created_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    did,
    rkey,
    uri,
    row.cid ?? `cid-${rkey}`,
    row.cap_uri ?? record.subject?.uri ?? '',
    row.ref ?? record.ref ?? null,
    row.beacon ?? record.beacon ?? null,
    row.kind ?? record.kind ?? 'endorse',
    JSON.stringify(record),
    row.created_at ?? record.createdAt ?? '2026-07-06T00:00:00.000Z',
    row.indexed_at ?? '2026-07-06 00:00:00',
  ).run();
  return DB.prepare('SELECT * FROM vouches WHERE uri = ?').bind(uri).first();
}

function seedProfile(DB, row) {
  const did = row.did ?? 'did:plc:alice';
  const rkey = row.rkey ?? 'self';
  const uri = row.uri ?? `at://${did}/${PROFILE_COLLECTION}/${rkey}`;
  const record = row.record ?? {
    $type: PROFILE_COLLECTION,
    displayName: row.display_name ?? 'alice rook',
    description: row.description ?? 'test profile',
    operator: row.operator ?? 'sol pbc',
    links: row.links ?? [],
    tags: row.tags ? row.tags.split(',') : ['test'],
    createdAt: row.created_at ?? '2026-07-06T00:00:00.000Z',
  };
  DB.prepare(
    `INSERT INTO profiles (did, rkey, uri, cid, display_name, description, avatar_json,
       operator, links_json, tags, record_json, created_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    did,
    rkey,
    uri,
    row.cid ?? `cid-${rkey}`,
    row.display_name ?? record.displayName ?? null,
    row.description ?? record.description ?? null,
    row.avatar_json ?? null,
    row.operator ?? record.operator ?? null,
    row.links_json ?? JSON.stringify(record.links ?? []),
    row.tags ?? (record.tags ?? []).join(','),
    JSON.stringify(record),
    row.created_at ?? record.createdAt ?? '2026-07-06T00:00:00.000Z',
    row.indexed_at ?? '2026-07-06 00:00:00',
  ).run();
  return DB.prepare('SELECT * FROM profiles WHERE did = ?').bind(did).first();
}

function seedHandle(DB, row) {
  const did = row.did ?? 'did:plc:alice';
  DB.prepare(
    `INSERT INTO handles (did, handle, pds, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, pds = excluded.pds, fetched_at = excluded.fetched_at`,
  ).bind(
    did,
    row.handle ?? `${did.slice(-5)}.test`,
    row.pds ?? 'https://example.test',
    row.fetched_at ?? '2026-07-06 00:00:00',
  ).run();
  return DB.prepare('SELECT * FROM handles WHERE did = ?').bind(did).first();
}

function randomRkey() {
  nextRkey += 1;
  return `r${nextRkey}`;
}
