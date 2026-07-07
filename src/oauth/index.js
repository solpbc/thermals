// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// atproto OAuth write path — the single human write surface in v1. A bsky user
// signs in with their handle and posts an org.v-it.cap kind:request to THEIR
// OWN PDS. thermals acts as an authorized client at the moment of posting and
// retains only the OAuth session (no copy of the record; spec §3, privacy §).
//
// Public client (token_endpoint_auth_method=none): PKCE + DPoP, no client
// secret, no JWKS. We only need one write per sign-in, so no refresh-token
// machinery — the session is short-lived and scoped to posting.

import {
  pkce, generateDpopKey, exportPrivateKey, importPrivateKey,
  dpopProof, randomToken, encryptJson, decryptJson,
} from './crypto.js';
import { resolveHandleToDid, resolvePds, resolveAuthServer } from './identity.js';
import { upsertCap } from '../store.js';
import { resolveDid } from '../atproto.js';

const SCOPE = 'atproto transition:generic';
const SESSION_COOKIE = 'thermals_sid';
const CAP_COLLECTION = 'org.v-it.cap';

export function isOauthPath(pathname) {
  return pathname === '/client-metadata.json' || pathname.startsWith('/oauth/');
}

function clientId(env) {
  return `${env.OAUTH_CLIENT_URI}/client-metadata.json`;
}
function redirectUri(env) {
  return `${env.OAUTH_CLIENT_URI}/oauth/callback`;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

export async function handleOauth(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/client-metadata.json') return clientMetadata(env);
  if (pathname === '/oauth/login' && request.method === 'POST') return login(request, env);
  if (pathname === '/oauth/callback') return callback(request, env);
  if (pathname === '/oauth/session') return sessionInfo(request, env);
  if (pathname === '/oauth/post' && request.method === 'POST') return post(request, env);
  if (pathname === '/oauth/logout' && request.method === 'POST') return logout(request, env);
  return json({ error: 'not found' }, 404);
}

// Public OAuth client metadata document (client_id resolves here).
function clientMetadata(env) {
  return json({
    client_id: clientId(env),
    client_name: 'thermals.cloud',
    client_uri: env.OAUTH_CLIENT_URI,
    redirect_uris: [redirectUri(env)],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: SCOPE,
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  });
}

// Step 1: resolve identity, PAR with PKCE+DPoP, redirect to the authz server.
async function login(request, env) {
  let handleInput;
  try {
    const body = await request.json();
    handleInput = body.handle;
  } catch { return json({ error: 'handle required' }, 400); }
  if (!handleInput) return json({ error: 'handle required' }, 400);

  const did = await resolveHandleToDid(handleInput);
  if (!did) return json({ error: 'could not resolve handle' }, 400);
  const pds = await resolvePds(did);
  if (!pds) return json({ error: 'could not resolve PDS' }, 400);
  const as = await resolveAuthServer(pds);

  const { verifier, challenge } = await pkce();
  const dpop = await generateDpopKey();
  const state = randomToken(24);

  // Pushed authorization request (DPoP-bound; may require a nonce retry).
  const parBody = {
    client_id: clientId(env),
    response_type: 'code',
    redirect_uri: redirectUri(env),
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: did,
  };
  const parRes = await dpopFetch(as.parEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parBody).toString(),
  }, { privateKey: dpop.privateKey, publicJwk: dpop.publicJwk, htm: 'POST', htu: as.parEndpoint });
  if (!parRes.ok) {
    return json({ error: 'PAR failed', detail: await parRes.text() }, 502);
  }
  const par = await parRes.json();

  // Persist request state (PKCE verifier + DPoP key) keyed by `state`.
  await env.DB.prepare(
    `INSERT INTO oauth_requests (state, did, handle, pds, auth_server, request_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+15 minutes'))`,
  ).bind(
    state, did, handleInput.replace(/^@/, ''), pds, as.issuer,
    JSON.stringify({
      verifier,
      dpopKey: await exportPrivateKey(dpop.privateKey),
      dpopJwk: dpop.publicJwk,
      tokenEndpoint: as.tokenEndpoint,
    }),
  ).run();

  const authUrl = new URL(as.authEndpoint);
  authUrl.searchParams.set('client_id', clientId(env));
  authUrl.searchParams.set('request_uri', par.request_uri);
  return json({ authorize_url: authUrl.toString() });
}

// Step 2: exchange the code for a DPoP-bound access token, store the session.
async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) return htmlRedirect('/?auth=denied');
  if (!code || !state) return htmlRedirect('/?auth=error');

  const reqRow = await env.DB.prepare(
    "SELECT * FROM oauth_requests WHERE state = ? AND expires_at > datetime('now')",
  ).bind(state).first();
  if (!reqRow) return htmlRedirect('/?auth=expired');
  await env.DB.prepare('DELETE FROM oauth_requests WHERE state = ?').bind(state).run();

  const rj = JSON.parse(reqRow.request_json);
  const privateKey = await importPrivateKey(rj.dpopKey);

  const tokenBody = {
    client_id: clientId(env),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env),
    code_verifier: rj.verifier,
  };
  const tokRes = await dpopFetch(rj.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenBody).toString(),
  }, { privateKey, publicJwk: rj.dpopJwk, htm: 'POST', htu: rj.tokenEndpoint });
  if (!tokRes.ok) return htmlRedirect('/?auth=error');
  const tokens = await tokRes.json();

  const sid = randomToken(24);
  const sessionData = {
    did: tokens.sub || reqRow.did,
    handle: reqRow.handle,
    pds: reqRow.pds,
    accessToken: tokens.access_token,
    dpopKey: rj.dpopKey,
    dpopJwk: rj.dpopJwk,
  };
  await env.DB.prepare(
    `INSERT INTO oauth_sessions (id, did, handle, pds, auth_server, session_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+2 hours'))`,
  ).bind(
    sid, sessionData.did, sessionData.handle, sessionData.pds, reqRow.auth_server,
    await encryptJson(sessionData, env.SESSION_SECRET),
  ).run();

  return htmlRedirect('/?auth=ok', {
    'Set-Cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7200`,
  });
}

// Return the signed-in identity for the UI (or null).
async function sessionInfo(request, env) {
  const s = await loadSession(request, env);
  if (!s) return json({ session: null });
  return json({ session: { did: s.did, handle: s.handle } });
}

// Step 3: post a work request to the signed-in user's OWN PDS.
async function post(request, env) {
  const s = await loadSession(request, env);
  if (!s) return json({ error: 'not signed in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad body' }, 400); }
  const beacon = (body.beacon || '').trim();
  const title = (body.title || '').trim();
  const description = (body.description || '').trim();

  if (!title) return json({ error: 'title required' }, 400);
  if (!isUrlShaped(beacon)) return json({ error: 'beacon must be a repo URL' }, 400);

  const record = {
    $type: CAP_COLLECTION,
    kind: 'request',
    title: title.slice(0, 512),
    description: description.slice(0, 10000),
    text: description.slice(0, 50000),
    ref: autoRef(title),
    beacon,
    createdAt: new Date().toISOString(),
  };

  const privateKey = await importPrivateKey(s.dpopKey);
  const endpoint = `${s.pds}/xrpc/com.atproto.repo.createRecord`;
  const res = await dpopFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `DPoP ${s.accessToken}` },
    body: JSON.stringify({ repo: s.did, collection: CAP_COLLECTION, record }),
  }, { privateKey, publicJwk: s.dpopJwk, htm: 'POST', htu: endpoint, accessToken: s.accessToken });

  if (!res.ok) return json({ error: 'post failed', detail: await res.text() }, 502);
  const created = await res.json();

  // Index the just-created request immediately. This is not "retaining a copy
  // as origin" — the record's origin is the user's PDS; this is the same
  // disposable cache the indexer maintains, populated from the public record we
  // just observed. It makes SSO-posted requests appear without waiting on
  // jetstream propagation (which lags for custom collections). The indexer's
  // delete-reconcile still governs: delete it at your PDS and it disappears here.
  await resolveDid(s.did, env);
  await upsertCap(env, s.did, created.uri, created.cid, record).catch(() => {});

  return json({ ok: true, uri: created.uri, ref: record.ref });
}

async function logout(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (sid) await env.DB.prepare('DELETE FROM oauth_sessions WHERE id = ?').bind(sid).run();
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  });
}

// ---- helpers ----

async function loadSession(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(
    "SELECT session_json FROM oauth_sessions WHERE id = ? AND expires_at > datetime('now')",
  ).bind(sid).first();
  if (!row) return null;
  try { return await decryptJson(row.session_json, env.SESSION_SECRET); } catch { return null; }
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
  return null;
}

// DPoP-authenticated fetch with a single automatic nonce retry: atproto servers
// return a DPoP-Nonce header and 400/401 use_dpop_nonce on the first attempt.
async function dpopFetch(urlStr, init, dpopParams) {
  const attempt = async (nonce) => {
    const proof = await dpopProof({ ...dpopParams, nonce });
    return fetch(urlStr, { ...init, headers: { ...init.headers, DPoP: proof } });
  };
  let res = await attempt(undefined);
  if (res.status === 400 || res.status === 401) {
    const nonce = res.headers.get('DPoP-Nonce');
    if (nonce) res = await attempt(nonce);
  }
  return res;
}

function htmlRedirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

function isUrlShaped(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

// Mirror `vit ship --kind request`: ref auto-generated from the title.
function autoRef(title) {
  const words = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(Boolean);
  const base = words.slice(0, 3).join('-') || 'work-request-open';
  return base + '-' + randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
}
