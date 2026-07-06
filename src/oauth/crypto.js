// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// WebCrypto primitives for the atproto OAuth flow: base64url, SHA-256, PKCE,
// and DPoP (ES256 / ECDSA P-256) proof generation + JWK thumbprints. No node
// crypto, no external libs — runs natively on Cloudflare Workers.

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// PKCE: verifier + S256 challenge.
export async function pkce() {
  const verifier = randomToken(32);
  const challenge = b64url(await sha256(verifier));
  return { verifier, challenge };
}

// Generate a fresh ES256 keypair for DPoP. Returns { privateKey (CryptoKey),
// publicJwk, jkt }.
export async function generateDpopKey() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
  const jkt = await jwkThumbprint(publicJwk);
  return { privateKey: kp.privateKey, publicJwk, jkt };
}

// RFC 7638 JWK thumbprint (SHA-256, base64url).
export async function jwkThumbprint(jwk) {
  const canon = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(await sha256(canon));
}

// Serialize a DPoP private key (PKCS8) for D1 storage.
export async function exportPrivateKey(privateKey) {
  return b64url(await crypto.subtle.exportKey('pkcs8', privateKey));
}

export async function importPrivateKey(b64) {
  return crypto.subtle.importKey(
    'pkcs8', b64urlToBytes(b64),
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
  );
}

// Sign a compact ES256 JWT. header + payload objects; key = ECDSA P-256 private.
export async function signJwt(header, payload, privateKey) {
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${h}.${p}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// Build a DPoP proof JWT for a request. `ath` (access-token hash) and `nonce`
// are included when present (resource/token requests carry them).
export async function dpopProof({ privateKey, publicJwk, htm, htu, nonce, accessToken }) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk };
  const payload = {
    jti: randomToken(16),
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = b64url(await sha256(accessToken));
  return signJwt(header, payload, privateKey);
}

// AES-GCM encrypt/decrypt a JSON session blob with a secret string.
async function aesKey(secret) {
  const raw = await sha256(secret);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(obj, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decryptJson(blob, secret) {
  const [ivPart, ctPart] = blob.split('.');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(ivPart) }, key, b64urlToBytes(ctPart),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}
