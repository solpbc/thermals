// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Offline unit tests for the OAuth crypto primitives — no network. These are
// the security-critical path (PKCE, DPoP signing, session encryption), so they
// carry the test weight.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64url, b64urlToBytes, sha256, pkce, generateDpopKey, signJwt,
  dpopProof, jwkThumbprint, encryptJson, decryptJson,
  exportPrivateKey, importPrivateKey,
} from '../src/oauth/crypto.js';

test('b64url round-trips bytes without padding', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = b64url(bytes);
  assert.ok(!encoded.includes('='));
  assert.ok(!encoded.includes('+'));
  assert.ok(!encoded.includes('/'));
  assert.deepEqual([...b64urlToBytes(encoded)], [...bytes]);
});

test('pkce challenge is S256(verifier)', async () => {
  const { verifier, challenge } = await pkce();
  assert.equal(challenge, b64url(await sha256(verifier)));
  assert.ok(verifier.length >= 32);
});

test('DPoP proof is a well-formed, verifiable ES256 JWT', async () => {
  const key = await generateDpopKey();
  const proof = await dpopProof({
    privateKey: key.privateKey, publicJwk: key.publicJwk,
    htm: 'POST', htu: 'https://pds.example/xrpc/com.atproto.repo.createRecord',
    nonce: 'abc', accessToken: 'tok123',
  });
  const [h, p, sig] = proof.split('.');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'ES256');
  assert.equal(header.jwk.crv, 'P-256');
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.nonce, 'abc');
  assert.ok(payload.jti && payload.iat && payload.ath);

  // Signature verifies against the embedded public JWK.
  const pub = await crypto.subtle.importKey(
    'jwk', { ...header.jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pub,
    b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  assert.ok(ok, 'DPoP signature must verify');
});

test('jwk thumbprint is deterministic', async () => {
  const key = await generateDpopKey();
  const again = await jwkThumbprint(key.publicJwk);
  assert.equal(key.jkt, again);
});

test('DPoP private key survives export/import and still signs', async () => {
  const key = await generateDpopKey();
  const exported = await exportPrivateKey(key.privateKey);
  const reimported = await importPrivateKey(exported);
  const jwt = await signJwt({ typ: 'JWT', alg: 'ES256' }, { hello: 'world' }, reimported);
  assert.equal(jwt.split('.').length, 3);
});

test('session encryption round-trips and is tamper-evident', async () => {
  const secret = 'test-session-secret';
  const session = { did: 'did:plc:abc', accessToken: 'secret-token', dpopKey: 'k' };
  const blob = await encryptJson(session, secret);
  assert.deepEqual(await decryptJson(blob, secret), session);
  await assert.rejects(() => decryptJson(blob, 'wrong-secret'));
});
