// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Resolve an atproto identity for the OAuth flow: handle → DID → PDS →
// authorization server metadata. Server-side fetches only (byte-clean holds
// for the browser).

const HANDLE_RESOLVER = 'https://public.api.bsky.app';

// handle (or bare DID) → DID.
export async function resolveHandleToDid(input) {
  const handle = input.trim().replace(/^@/, '');
  if (handle.startsWith('did:')) return handle;

  // Primary: the PDS-agnostic identity resolver.
  try {
    const u = new URL(`${HANDLE_RESOLVER}/xrpc/com.atproto.identity.resolveHandle`);
    u.searchParams.set('handle', handle);
    const res = await fetch(u.toString());
    if (res.ok) {
      const did = (await res.json())?.did;
      if (did) return did;
    }
  } catch { /* fall through */ }

  // Fallback: the handle's own .well-known.
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`);
    if (res.ok) {
      const did = (await res.text()).trim();
      if (did.startsWith('did:')) return did;
    }
  } catch { /* fall through */ }

  return null;
}

// DID → PDS service endpoint (via the DID document).
export async function resolvePds(did) {
  let doc = null;
  if (did.startsWith('did:plc:')) {
    const res = await fetch(`https://plc.directory/${did}`);
    doc = res.ok ? await res.json() : null;
  } else if (did.startsWith('did:web:')) {
    const host = did.slice('did:web:'.length).replace(/:/g, '/');
    const res = await fetch(`https://${host}/.well-known/did.json`);
    doc = res.ok ? await res.json() : null;
  }
  if (!doc?.service) return null;
  return doc.service.find(
    (s) => s?.id === '#atproto_pds' || s?.type === 'AtprotoPersonalDataServer',
  )?.serviceEndpoint ?? null;
}

// PDS → authorization server metadata (endpoints for PAR / authorize / token).
export async function resolveAuthServer(pds) {
  const prRes = await fetch(`${pds}/.well-known/oauth-protected-resource`);
  if (!prRes.ok) throw new Error('no oauth-protected-resource at PDS');
  const pr = await prRes.json();
  const issuer = pr.authorization_servers?.[0];
  if (!issuer) throw new Error('PDS advertises no authorization server');

  const asRes = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (!asRes.ok) throw new Error('no oauth-authorization-server metadata');
  const as = await asRes.json();
  return {
    issuer: as.issuer,
    parEndpoint: as.pushed_authorization_request_endpoint,
    authEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
  };
}
