// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// atproto identity + repo helpers. thermals resolves DIDs to handles and PDS
// endpoints so it can render authorship and fetch records/blobs. All reads are
// of public network data; nothing here writes.

export const CAP_COLLECTION = 'org.v-it.cap';
export const VOUCH_COLLECTION = 'org.v-it.vouch';
export const PROFILE_COLLECTION = 'cloud.thermals.actor.profile';

const PLC_DIRECTORY = 'https://plc.directory';

// Resolve a DID document → { handle, pds }. did:plc via plc.directory; did:web
// via its .well-known. Cached in D1 for 24h.
export async function resolveDid(did, env) {
  try {
    const cached = await env.DB.prepare(
      "SELECT handle, pds, fetched_at FROM handles WHERE did = ? AND fetched_at > datetime('now', '-24 hours')",
    ).bind(did).first();
    if (cached?.handle && cached?.pds) {
      return { handle: cached.handle, pds: cached.pds };
    }

    const doc = await fetchDidDoc(did);
    if (!doc) return null;

    const handle = Array.isArray(doc.alsoKnownAs)
      ? doc.alsoKnownAs.find((v) => typeof v === 'string' && v.startsWith('at://'))?.slice(5) ?? null
      : null;
    const pds = Array.isArray(doc.service)
      ? doc.service.find((s) => s?.id === '#atproto_pds' || s?.type === 'AtprotoPersonalDataServer')?.serviceEndpoint ?? null
      : null;

    if (handle || pds) {
      await env.DB.prepare(
        `INSERT INTO handles (did, handle, pds, fetched_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(did) DO UPDATE SET
           handle = excluded.handle, pds = excluded.pds, fetched_at = excluded.fetched_at`,
      ).bind(did, handle ?? did, pds ?? null).run();
    }
    return { handle: handle ?? did, pds };
  } catch {
    return null;
  }
}

async function fetchDidDoc(did) {
  if (did.startsWith('did:plc:')) {
    const res = await fetch(`${PLC_DIRECTORY}/${did}`);
    return res.ok ? await res.json() : null;
  }
  if (did.startsWith('did:web:')) {
    const host = did.slice('did:web:'.length).replace(/:/g, '/');
    const res = await fetch(`https://${host}/.well-known/did.json`);
    return res.ok ? await res.json() : null;
  }
  return null;
}

// Batch-resolve DIDs (best-effort, sequential to stay within Worker limits).
export async function resolveDids(dids, env) {
  for (const did of dids) {
    await resolveDid(did, env);
  }
}

// The content CID of an atproto blob ref (the `ref.$link`). Content-addressed,
// so it doubles as a cache version: when a profile's avatar changes, its CID
// changes, which is how downstream cache revalidation is triggered.
export function blobCid(blobRef) {
  return blobRef?.ref?.$link ?? blobRef?.ref?.toString?.() ?? null;
}

// Build a public blob URL for an avatar via the author's PDS getBlob.
export function blobUrl(pds, did, blobRef) {
  const cid = blobCid(blobRef);
  if (!pds || !cid) return null;
  return `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}

// List all records of a collection in a repo, following the cursor. Returns
// [{ uri, cid, value }]. Used by the commons poll (relay-independent path).
export async function listRecords(pdsBase, did, collection) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${pdsBase}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set('repo', did);
    url.searchParams.set('collection', collection);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString());
    if (!res.ok) break;
    const data = await res.json();
    for (const r of data.records ?? []) {
      out.push({ uri: r.uri, cid: r.cid, value: r.value });
    }
    cursor = data.cursor ?? null;
    if (!cursor || (data.records ?? []).length === 0) break;
  }
  return out;
}

// List repos hosted by a PDS/commons. Returns [{ did, active }].
export async function listRepos(pdsBase) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${pdsBase}/xrpc/com.atproto.sync.listRepos`);
    url.searchParams.set('limit', '500');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString());
    if (!res.ok) break;
    const data = await res.json();
    for (const r of data.repos ?? []) {
      if (r.did) out.push({ did: r.did, active: r.active !== false });
    }
    cursor = data.cursor ?? null;
    if (!cursor || (data.repos ?? []).length === 0) break;
  }
  return out;
}

export function rkeyFromUri(uri) {
  return uri.split('/').pop();
}
