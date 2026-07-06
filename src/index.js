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

async function runIndexer(env) {
  // Commons poll first (bounded, relay-independent), then the network tail.
  const commons = await pollCommons(env).catch((e) => ({ error: String(e) }));
  const stream = await streamEvents(env, null).catch((e) => ({ error: String(e) }));
  return { commons, stream };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/_index_now') {
      // Dev/ops trigger to run one index cycle synchronously.
      const result = await runIndexer(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    if (isOauthPath(url.pathname)) {
      return handleOauth(request, env);
    }

    // Fall through to static assets (VPX). If assets miss, 404.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIndexer(env));
  },
};
