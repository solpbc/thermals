// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

// Durable Object holding the Jetstream cursor between cron ticks.
export class CursorStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'GET') {
      return new Response((await this.state.storage.get('cursor')) || '');
    }
    if (request.method === 'PUT') {
      await this.state.storage.put('cursor', await request.text());
      return new Response('ok');
    }
    return new Response('method not allowed', { status: 405 });
  }
}
