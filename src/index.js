// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// thermals.cloud appview — entry point. Serves the read APIs (/api/*), the
// atproto OAuth write path (/oauth/*, /client-metadata.json, /jwks.json), and
// runs the dual-path indexer on cron (Jetstream tail + direct commons poll).
// Static assets (the VPX experience layer) are served by the [assets] binding.

import { handleApi } from './api.js';
import { handleOauth, isOauthPath } from './oauth/index.js';
import { streamEvents } from './jetstream.js';
import { pollCommons } from './commons.js';

export { CursorStore } from './cursor.js';

// Byte-clean posture (Article 8): zero third-party requests on the live zone.
// CSP allows only same-origin script/style/font/img/fetch — the VPX assets are
// fully self-hosted and /api/avatar proxies images same-origin.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; " +
    "script-src 'self'; " +
    "style-src 'self'; " +
    "font-src 'self'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // `no-transform` stops Cloudflare's edge from injecting the Web Analytics
  // beacon (static.cloudflareinsights.com) into HTML — auto-injection is on by
  // default for new zones and can't be disabled per-zone via API token.
  const cacheControl = headers.get('Cache-Control');
  if (cacheControl) {
    if (!/(^|,\s*)no-transform(\s*,|$)/.test(cacheControl)) {
      headers.set('Cache-Control', cacheControl + ', no-transform');
    }
  } else {
    headers.set('Cache-Control', 'no-transform');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function runIndexer(env) {
  // Commons poll first (bounded, relay-independent), then the network tail.
  const commons = await pollCommons(env).catch((e) => ({ error: String(e) }));

  // Resume the Jetstream tail from the persisted cursor so events landing in
  // the gap between cron windows are replayed, not lost — without this, a
  // delete (or an off-flow post) emitted while no tail is connected would
  // never reach the index. Records are idempotent, so replay overlap is safe.
  const cursorStub = env.CURSOR_STORE.get(env.CURSOR_STORE.idFromName('jetstream'));
  let cursor = null;
  try {
    cursor = (await (await cursorStub.fetch('https://cursor/', { method: 'GET' })).text()) || null;
  } catch { /* first run or DO hiccup — tail from the live tip */ }

  const stream = await streamEvents(env, cursor).catch((e) => ({ error: String(e) }));
  if (stream?.latestCursor) {
    try {
      await cursorStub.fetch('https://cursor/', { method: 'PUT', body: stream.latestCursor });
    } catch { /* next window replays from the previous cursor — idempotent */ }
  }
  return { commons, stream };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Canonicalize: www → apex (OAuth client_id is the apex origin).
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/api/_index_now') {
      // Dev/ops trigger to run one index cycle synchronously.
      const result = await runIndexer(env);
      return withSecurityHeaders(
        new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    if (url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(await handleApi(request, env));
    }

    if (isOauthPath(url.pathname)) {
      return withSecurityHeaders(await handleOauth(request, env));
    }

    // Fall through to static assets (VPX). If assets miss, 404.
    if (env.ASSETS) return withSecurityHeaders(await env.ASSETS.fetch(request));
    return withSecurityHeaders(new Response('not found', { status: 404 }));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIndexer(env));
  },
};
